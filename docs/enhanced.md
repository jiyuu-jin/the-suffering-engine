# Enhanced graphics mode

An optional modern renderer that sits next to the faithful one. **Original** stays the default.
It is the engine's look, byte for byte: gamma back buffer, vertex lighting, linear gamma fog, no
post stack. **Enhanced** answers a thought experiment: how dark, modern and disturbing can this
game look in 2026, using lighting that scales with the GPU, without turning cheesy? It keeps the
level's authored mood (its own lights, light regions, flicker, alarms and fog) and re-renders it
with physically based light, real shadows, volumetric scattering and a filmic horror grade.

Code: `src/app/enhanced/*`, with small gated hooks in `engine-light.ts`, `surface-material.ts`,
`renderer.ts`, `game/insanity/effects.ts` and the menu (`menu/graphics.ts`, `menu/gui-adapter.ts`).
Comparison and image checks: `tools/enhanced-compare.ts`, `tools/image-metrics.ts`; tests:
`tests/enhanced.test.ts`, `tests/enhanced-look.test.ts`. Texture enhancement:
`src/app/enhanced/maps/*`, `tools/enhance-textures.ts`, `tools/enhance-detail.ts`,
`tests/enhanced-maps.test.ts`. Gore: `src/app/enhanced/gore/*`, listening to the game's blood
events through `game/fx/gore-bus.ts`; `tests/enhanced-gore.test.ts`.

## Choosing the mode

| Where | Mode | Quality |
|---|---|---|
| URL (testing) | `?gfx=enhanced` / `?gfx=original` | `?tier=low\|medium\|high\|ultra\|auto` |
| Graphics page | Graphics Mode: Original / Enhanced (`x.gfxMode`) | Enhanced Quality: Auto / Low / Medium / High / Ultra (`x.gfxTier`) |
| Default | Original | Auto |

The URL wins over the saved settings (`suffering.settings.v1`, see `config.ts resolveGraphics`).
The mode is fixed for the page's lifetime because it decides the back-buffer format and every
material's shader. A change on the Graphics page takes effect on the next start. The tier changes
immediately: it only rebuilds the post chain and resizes the shadow maps. A `?tier=` URL override
holds until the Quality row is actually changed. The two rows are engine additions below Frame
Rate Limit; to fit above Accept / Cancel, the graphics page's value rows close up from 8 % to 6 %
spacing (`menu/gui-adapter.ts`). `tools/playthrough.mjs --query 'gfx=enhanced&tier=high'`
runs any route in Enhanced mode.

### Original is untouched

- `renderer.ts` loads the Enhanced code only through `ENHANCED ? await import('./enhanced') : null`.
  The renderer otherwise imports nothing from it except a type, so an Original page never loads
  the module.
- Every hook in `engine-light.ts` is either unset in Original (`enhancedShading` stays `{}`) or
  chosen by the page constant `ENHANCED` (`config.ts`). With `ENHANCED = false` each function
  builds exactly the graph it built before: `GAMMA_BACK_BUFFER`, `BACK_BUFFER_TYPE`, the fog node,
  `engineStages`' saturation at 1, and `engineSurfaceFinish`, which is the old
  `toLinear(toSrgb(rgb) × shadow)` expression moved into a function. `engineAlbedo(g)` returns
  `g` itself and surfaces get no `glow` token while `enhancedShading.albedo` / `.glow` are unset.
- The engine's scene glow (`scene-glow.ts`) belongs to Original only. Enhanced uses its own
  bloom.
- Guards: `tests/enhanced.test.ts` covers the default mode, the gamma back buffer, the absence of
  hooks, the saturating passes, and that no shared module imports the Enhanced modules.
  `npm run smoke` checks that the default page has no Enhanced pipeline and uses
  LinearToneMapping on the 8-bit back buffer, and that `gfx=enhanced&tier=low` renders.

## Architecture

```
LevelRenderer.draw()                              (renderer.ts)
  culler, matrices, engineLights.update()         unchanged: the engine's light choice
  enhanced.draw(screenEffects?)                   (enhanced/index.ts)
    enhancedLights.update()                       lights.ts: flashlight, lamp picks, moonlight
    shadows.render()                              shadows.ts: flashlight / lamp cubes / moon
    pipeline.render()  (or screen effects, which call renderInto() for their scene)
      scene pass (HDR half float, MRT colour + velocity)
        x GTAO                     (AO from depth)
        + VolumetricNode           (volumetric.ts)
        -> TRAA                    (High / Ultra)
        + viewmodel pass           (arms / weapon; MSAA; coverage MRT)
        + bloom
        -> soft focus              (Ultra)
        -> lens + horror grade + tone curve + grain  (post.ts gradeNode, tone.ts)
        -> FXAA                    (Low / Medium)
        -> sRGB (canvas) or linear (insanity effects' scene target)
```

### Lighting (`shading.ts`, installed into `engine-light.ts enhancedShading`)

Every lit material in the port is engine-lit: texture × the engine's light L (light units, per
vertex, gamma). Enhanced keeps L as the surface's authored lighting (baked vertex colours,
Ambient Light regions, Directional Lights, Point Lights from Light Housings and Lighting Effects,
flicker, the red alarm wave) and adds light on top in linear HDR:

- `L' = max(L − lamp occlusion, 0.35 · L)`: a lamp shadow takes out at most 65 % of the
  authored light (`SHADOW_KEEP`), so baked light that is already dark never goes black.
- `E = max(softLight(L'), ambient floor)^2.2 + flashlight irradiance`, then
  `factor = ½ · E^(1/2.2)` back into the pass maths. `softLight` is the identity up to 1 and then
  saturates towards 1.6 (the original clamps L at 400/255 and saturates the pass at 1, so light
  above 1 only ever brightened dark texels). The ambient floor is half the ambient light of the
  camera's Ambient Light region, chosen by the engine's own rule for objects
  (`engineLights.objectLightSet(camera)`). A surface no Enhanced light reaches reads as authored.
- **Albedo**: a lit pass multiplies `min(texture, 0.906)` (gamma), at most 80 % reflectance
  (`enhancedShading.albedo`, `engineAlbedo`). Tinted (self-lit) passes are not clamped.
- **Emitters**: surfaces carrying the scene-glow mark (the bulbs and lamp glass that Original's
  scene glow blooms, `glowMarked`) are multiplied by `GLOW_GAIN` 4 in the HDR frame
  (`enhancedShading.glow`), so they, and not ordinary bright albedo, feed the bloom.
- **Flashlight**: a per-pixel physically based spot replaces the rig's per-vertex beam
  (`engineLights.perPixelFlashlight`). Cone 9° inner / 26° outer plus a 55° spill (4 %).
  Fall-off is `30 / (d² + 18)`, a soft near field because a reflector is not a point source:
  about 2.2 (linear irradiance, ×1.37 in the hot centre) at arm's length, 1.5 at 3 m, 0.75 at
  6 m. The original's beam (Spot Light 4:123, clamped at 400/255) peaks near 2.7 in a narrower
  cone. **Start** [verified]: the original's beam lights nothing nearer than its vertex shader's
  start constant along the beam's axis, c10.w = R·S / (L − S) from the Spot Light's p8..p10
  (`render-data.ts spotConstants`): 2 m for the flashlight's beam (1 / 6 / 10), 1.67 m for its
  spill. Enhanced fades its beam in across that distance along the axis, from 0.45 m before it
  to 0.3 m after (`FLASH_BEAM_START`, `FLASH_START_RAMP`, `EU.flStart`), surfaces and the
  volumetric beam alike (the original's per-vertex step is as soft across a floor's large
  triangles). Lit from 0.4 m (the
  previous rule, a fade over the first metre of distance), floors, bars and faces at arm's length
  read 1.2-1.45 × the original, and leaves right at the lens blew up into blurred, magnified
  blobs. With the decoded start the close-ups pass at every tier (floor 1.11-1.12 ×, bars
  0.62-0.72 ×, face 0.79-0.83 ×; a fade over the metre before 2 m still gave the floor 1.40 ×,
  and ±0.3 m 0.98 × but 13-14 % near black where Enhanced's lamp shadows fall). A generated
  lens cookie gives a hot centre and a faint reflector ring. Battery dimming comes through the
  SpotLight's intensity. It has a shadow map and GGX specular.
- **Specular**: GGX (height-correlated Smith, Schlick) from the flashlight and the
  `specularLights` strongest lamps near the camera. Fire, muzzle flashes and sparks count as lamps
  too. Up-facing surfaces are glossier (`floorRoughness` 0.38: wet floors). Elsewhere roughness
  is 0.68.
- **Lamp shadows** (High: 1 lamp, Ultra: 2): the strongest nearby engine point light gets a cube
  shadow map. Where it is occluded, that lamp's share of L (the engine's own formula,
  `colour · min(I/d², 2) · N·L`) is taken out, so cell bars and characters cast hard shadows from
  corridor lamps onto baked lighting. Occluders within 1.2 m of the lamp (`LAMP_FIXTURE`) are
  its own fixture (shade, cage, bulb; often in a prop batch shared by every lamp of the level)
  and cast nothing: the original's lamps light the room their shade would hide.
- **Projected character shadows** (the engine's own) are kept. They fade to half strength once
  real lamp shadows exist.
- **Fog**: the level's own linear fog (Sky Properties start / end / colour), applied in linear
  light (`EU.fogGain`).
- **Additive effects** (fire, sparks, arcs, glows) keep HDR headroom (`ADDITIVE_HDR` 1.6) so they
  bloom.

### Shadows (`shadows.ts`)

Each map stores the distance to the light as a fraction of its range, cleared to 1. Maps are drawn
with one distance material through `renderer.setRenderObjectFunction`, so the scene graph is
never touched. Alpha-tested surfaces (bars, grates, foliage) get a cut-out copy that reads their
texture's alpha; every cut-out copy shares one graph that reads the texture from the material
drawn (`materialReference('cutoutMap')`). Blended surfaces, sprites, points and lines cast
nothing. The zone culler's choice for the frame applies (same camera layers).

| Map | Kind | Update |
|---|---|---|
| Flashlight | perspective, 65° | every frame; casters within 14 m (`FLASH_SHADOW_REACH`) |
| Lamps (1-2) | cube | static casters: a face is drawn again only where something static changed, at most `lampFacesPerFrame` faces per frame (all six for a newly chosen lamp); moving casters: every frame, into the faces they touch |
| Moonlight | orthographic 80 m box around the camera, snapped to its texels | every second frame (`MOON_EVERY`) |

**Lamp cube caches.** Lamps do not move and most of what they light does not either. Each
shadowed lamp keeps two cubes: the static casters only (`still`), and the map the shading
samples. Once a frame (`scan`) every visible caster within the map's reach is classified: a
skinned mesh, or a mesh whose world transform changed within the last 30 frames (`STILL_FRAMES`),
is moving; the rest is static and remembered per lamp with a signature (transform, geometry,
draw range, index version, material) and the faces its bounding sphere can show in
(`cubeFaceMask`: the sphere against each face's 90° pyramid, conservative). A static caster that
appeared, changed or went away marks its old and new faces stale; a change of the camera's
layers (the zone culler) marks all six. Stale faces of `still` are drawn again with the static
casters only. Every face that was redrawn, holds moving casters, or held some last frame is then
rebuilt: the `still` face is copied in (`copyTextureToTexture`) and the moving casters are drawn
over it with a MIN blend (no depth buffer needed; the nearer distance wins). The moving pass walks
only the moving casters (the scene's children are swapped for the draw, which three.js's
projection walk allows because the scene's world matrices are not updated by `render()`).
Casters smaller than 0.1 m (bounding radius: drips, the morphing drip models, shell casings) are
left out of the lamp cubes: they came and went every frame and kept the static faces stale, for
shadows a few centimetres across. A frame drawn with every face refreshed differs from the cached
one by 0.2 levels of mean luma (TRAA noise). Ultra's two lamps cost 2300 draws and 30 ms of
main-thread time a frame before; at rest they cost the copies and the moving casters.

The lamp cube targets are created anew when a tier changes their size: three.js r186's WebGPU
backend never draws into a cube target resized with `setSize` (it stayed all zero), and the
shading reads them through cube texture nodes whose value is swapped.

PCF uses a Vogel disk rotated by interleaved-gradient noise (`shadowTaps`). TRAA resolves the
noise.

### Volumetrics (`volumetric.ts`)

A ray march from the camera to the depth buffer, or to the fog end, at `volumetricScale`
resolution with `volumetricSteps` steps and per-frame jitter. Density is `1.4 / fogEnd`, so
thicker fog means denser air, times a slowly drifting 3D noise (dust: MaterialX's Perlin noise,
baked once into a tiling 64³ texture, `dust-noise.ts`; docs/perf.md "Perf C"). Transmittance
follows the authored fog ramp. It scatters:

- the flashlight beam (Henyey-Greenstein g 0.35, through its shadow map, so bars cut the beam);
- lamp halos and shafts (g 0.25); the cube-shadowed lamps cast shafts;
- moonlight shafts through windows and trees (g 0.55): the dominant non-rim Directional Light
  whose region holds the camera, through the moonlight shadow map.

Scattering gains (`flashScatter` 0.1, `lampScatter` 0.25, `moonScatter` 0.25) are set so the
air reads as a dark haze, not a grey veil: at 1.0 the moonlight alone added 11 / 255 of mean
luminance to 3a's yard and removed every near-black pixel. The beam fades in over its first metre
like the surface light.

### Light volumes (`light-volume.ts`)

The level's light shafts and pools are flat additive sheets (1b's arena grate shaft `86c7`: four
boxes of 2 m walls; 1a's cell-lamp pools 7:292). Their textures fade only along the height and
the engine has no view-angle term, so each wall ends in a hard edge and a wall seen edge-on is a
pane of light (docs/re/renderer.md §5.3; Original keeps exactly that). Enhanced fades such a
sheet per fragment by how squarely it faces the eye, `smoothstep(0.1, 0.85, |N·V|)` with the flat
face normal (the models' own normals point anywhere), and over the first 0.3..1.5 m from the
camera, multiplying the light it adds.

Which surfaces (`isLightVolume`): level geometry (the renderer's merged parts, `levelGeometry`)
whose single pass is additive, tinted and without the glow mark. That is the light pools and
shafts (7:292, 4:1318, 9:5841, 9:5847, 3:4057), 1b's animated 7:1304 and 5b's 7:1308; fire and
lamp cards (glow-marked), glass shards (untinted) and the Sky / Sun cards (prop cache) are
untouched. `lightVolumeUniforms` (strength, ramps) can be set from the console for A/B shots.

Evidence (Enhanced Medium, the report's pose in 1b, 2246 × 1274 at Auto 65 %; strength 0 / 1 in
one session): shaft region mean luma 35.8 → 34.3, frame mean 28.0 → 27.1 (Original 41.0 with the
glow), grazing inner walls and the near-camera band fade. It does not soften a box's outer
silhouette, where two walls seen at ordinary angles stop together: that needs the light's path
length through the volume, e.g. a pass that adds the back faces' depth and subtracts the front
faces' into a thickness target and scales the sheets by it (next step).

### Post stack and horror grade (`post.ts`)

- **GTAO** (three.js `GTAONode`, depth-reconstructed normals) multiplied at 50 % (`grade.ao`):
  the baked light already carries the contact darkening. Below full resolution it reads a copy of
  the depth at its own size (`half-depth.ts`).
- **TRAA** (High / Ultra) or **FXAA** (Low / Medium). The scene pass has no MSAA because every
  depth consumer needs a single-sample depth texture.
- The **viewmodel** (first-person arms, weapon) is its own MSAA pass, composited by an MRT
  coverage target, so it gets the bloom and grade too. `renderViewmodel()` steps aside in
  Enhanced.
- **Bloom** (strength 0.45) of the energy above luminance 2 only (`grade.bloomThreshold`, hue
  kept): glow-marked emitters, lamps, fire, arcs, the flashlight's hot spot up close. Diffuse
  white under its brightest authored light stays below it.
- **Soft focus** (Ultra), very subtle: one pass, a 12-tap Vogel disc whose radius grows with the
  circle of confusion (three.js's rule, `smoothstep(0, 4 m, |z − 6 m|)`, up to 2.4 px;
  `post.ts focus`). It replaces three.js's `DepthOfFieldNode`, which drew the same subtle look (a
  bokeh of at most 1.2 px over a half-resolution copy) in six passes with 64- and 16-tap blurs:
  Ultra's most expensive pass (at 1a's cell row, with half-resolution volumetrics, 36 fps with
  it against 56 without; the soft focus costs nothing measurable).
- **Lens**: chromatic aberration growing towards the edges (0.0025). During insanity (the screen
  effects' blur, vignette or flash) the lens adds barrel distortion and more aberration and
  vignette.
- **Grade** (see Exposure below): exposure 0.85, saturation 0.9, a cold shadow tint and a
  sickly warm highlight tint (each at unit luminance: they shift hue, they do not darken), the
  hue-preserving tone curve, contrast 1.02 as a display-space power about 0.4 (black stays
  black), a small cold black lift, a vignette (0.3), and animated film grain (0.035).

Every grade value is a uniform (`__enhanced.uniforms.grade.*`), so none needs a rebuild.

### Exposure (`tone.ts`)

The original's frame is display-referred: texture × light on gamma values, saturated at 1, shown
as is. Enhanced renders it scene-referred and has to map it back without crushing the darks that
carry most of this game's frames, and without turning bright albedo into light sources:

| Step | Rule |
|---|---|
| Albedo | `min(texture, 80 %)` reflectance |
| Authored light | `softLight(L)`: identity to 1, saturating towards 1.6 |
| Tone curve | per pixel on the brightest channel after exposure: linear up to the knee 0.5, then `knee + (1 − knee)(1 − e^{−(m − knee)/(1 − knee)})`; the colour scales with it, so hue survives; only sources far above diffuse white (max channel 2.5 to 12) whiten |
| Display | sRGB, contrast as a power about 0.4, a lift of 1-3 / 255 |
| Bloom | energy above luminance 2 (scene-linear) |

`displayOf(texture, L)` in `tone.ts` is the CPU twin (tests). A grey surface the original shows
at 0.02 to 0.7 shows at 75-100 % of that value, diffuse white under L = 1 at 0.87.

What it replaced, and why it failed the user's test of Medium, High and Ultra:

- **AgX plus a linear-light contrast about 0.18 with `max(0)`** sent every value the original
  shows below about 0.17 (43 / 255) to the black floor. In a dark prison that is most of the
  frame: "dark surfaces too dark".
- **Bloom at threshold 0.85 on the full colour** caught every pale surface under its own light
  (a white texture at L = 1 is 1.0 linear), and **L kept up to 3.2** (the original clamps at
  1.57) made pale walls 5 to 13 times their albedo: "white surfaces emitting light".
- **AgX** desaturates towards white: the gas chamber's green glass turned white. The tone curve
  on the brightest channel keeps its hue.
- **The flashlight** (45 / (d² + 5)) gave 12 times the albedo at arm's length.

### Precompile (`post.ts`, `shadows.ts`, `prewarm.ts warmPasses`, `renderer.ts precompile`)

Enhanced draws the scene into its own passes, never into the canvas: the scene pass (HDR, MRT
colour + velocity at every tier, so a tier switch reuses its shaders), the viewmodel pass (MSAA, MRT colour + coverage) and the
shadow maps (red half float, depth; distance materials instead of the scene's). three.js keys
shaders and pipelines by the render context, so Original's load-time precompile (the canvas
pass) built nothing Enhanced drew, and every zone, character and caster first seen in play built
its shaders then: in 5a at High, flying past sixteen points after the load built 308 node
shaders (284 pipelines), with frames up to 1.1 s. The passes now register in `warmPasses`, and
`LevelRenderer.precompile()` compiles them at a load (while the frame loop is suspended):

- one pass at a time, holding the renderer's target and MRT until the pass's shaders are built:
  three.js reads both when its asynchronous shader builds run, not when `compileAsync()` is
  called (with the state restored at once, the shaders came out without the pass's outputs and
  the pipelines failed); Enhanced's `precompile()` calls run one after another for the same
  reason (the load's and the visibility system's first update overlapped);
- in the pass's own render context: a pass inside the post chain is a nested render (the scene
  pass at depth 3 with TRAA, the viewmodel pass at 2), and three.js keys contexts by that depth;
  `compileAsync()` always takes the top-level one. `EnhancedPipeline.probe()` draws the chain once
  with both cameras on no layer to record each pass's depth (and builds the post passes' own
  pipelines behind the loading screen); the compile then asks for that context;
- the shadow maps with each caster's distance material, plain and MIN-blended (`WarmPass.material`):
  all the maps share one render state, so compiling into the flashlight's map covers them all.

The canvas compile is skipped in Enhanced (nothing of the scene is drawn there). Same flight in
5a after the change: 10 node shaders (8 pipelines: effects), no frame over 50 ms. Load-time
compile: 5.9 s (6.0 s before, which was spent on the canvas pass).

### Insanity screen effects

`ScreenEffects.render()` asks `view.enhanced.renderInto()` for its scene: the whole graded
Enhanced frame, in linear. The blur trail, faders and hallucination flashes then composite as
before.

## Tiers

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Render scale | 0.75 | 1 | 1 | 1 |
| Flashlight shadow | 512, 1 tap | 1024, 4 taps | 2048, 9 taps | 2048, 16 taps |
| Lamp cube shadows | none | none | 1 lamp at 512, 2 faces/frame | 2 lamps at 1024, 6 faces/frame |
| Moonlight shadow | none | 1024 | 2048 | 4096 |
| Specular lamps | 2 | 4 | 6 | 8 |
| Volumetrics | 8 steps, ½ res | 16, ½ | 24, ½ | 40, ½ |
| GTAO | off | 8 samples, ½ res | 12, ½ | 16, full |
| Bloom | on | on | on | on |
| AA | FXAA | FXAA | TRAA | TRAA |
| Soft focus (depth of field) | | | | on |

`TierFeatures.ssr` is reserved (off everywhere for now; see Limits).

**Auto** (`auto-tier.ts`):

1. *Starting tier.* Adapter limits and features give a score from 0 to 4
   (maxTextureDimension2D ≥ 16384, storage buffers ≥ 1 GiB, `shader-f16`, timestamp queries or
   float32-filterable). A short GPU timing probe then runs: six best-of frames of a fixed
   96-iteration ALU shader on a 1024² half-float target, timed with `onSubmittedWorkDone`.
   ≤ 1.5 ms gives Ultra, ≤ 5 High, ≤ 12 Medium, otherwise Low. A score ≤ 1 caps the result at
   Medium, and fallback adapters get Low.
2. *Governor.* It works on 1.5 s windows of frame intervals. Two windows under 85 % of the
   target (60 fps, or the frame cap) drop one tier. Three windows at the target with the frame's
   CPU work under 45 % raise one tier. Every change has a 3 s cooldown. A raise undone within 8 s
   bans that tier for a minute. `__enhanced.governor.log` keeps the history.

**WebGL2 fallback**: Enhanced runs on the WebGL2 backend capped at Medium (`WEBGL_MAX_TIER`).

## Performance

Measured in headless Brave (`--headless=new --enable-unsafe-webgpu`, 1280×583 viewport, DPR 1)
on the development Mac while other agents' headless browsers and dev servers were running (load
average 11-15), by `tools/enhanced-compare.ts --tiers low,medium,high,ultra --fps 3`. The
absolute numbers are noisy; the comparisons below were measured back to back in one browser,
the "before" from a copy of commit 34ef721 served by a second dev server. Each value is the frame
probe's fps over 3 s, fly camera at the evidence poses; a cell is the mean over the level's
poses, the range across poses in brackets. 60 is the headless browser's ceiling (display rate).

2026-10-23, before → after the performance work (shadow caches, half-resolution Ultra
volumetrics, soft focus, flashlight shadow reach):

| Level (poses) | Original | Low | Medium | High | Ultra |
|---|---|---|---|---|---|
| 1a Death Row (cell row, lamp, guard corridor, gas chamber ×2, electrocution controls, dark cell) | 60 → 60 | 60 → 60 | 60 → 60 | 60 (59-60) → 60 (60-60) | 36 (29-45) → 60 (60-60) |
| 1a close-ups (floor, bars, face) | 60 → 60 | 60 → 58 (53-60) | 60 → 60 | 60 → 60 | 35 (33-37) → 60 (60-60) |
| 3a Yard, night (2) | 54 → 58 | 60 → 60 | 60 → 60 | 60 → 60 | 50 (46-53) → 59 (58-60) |
| 6a Woods, night and rain (2) | 60 → 60 | 60 → 60 | 60 → 60 | 60 → 60 | 60 → 60 |

The three 1a poses that were slowest, Ultra and High, main-thread time per frame from the frame
probe (`shadows` = `EnhancedShadows.render`, `pipeline` = the post chain's render), measured back
to back at load average 12 (`scratchpad/enhpolish/bin/fps1a.sh`):

| Pose | Ultra before: fps / shadows ms (draws) | Ultra after | High before | High after |
|---|---|---|---|---|
| 1a cell row | 34.5 / 18.4 (2347) | 60 / 2.4 (173) | 60 / 5.7 (539) | 60 / 2.6 (169) |
| 1a guard corridor | 33.2 / 18.4 (2154) | 60 / 2.7 (223) | 56 / 5.5 (510) | 60 / 3.1 (218) |
| 1a gas chamber | 32.8 / 15.9 (1771) | 52 / 3.5 (232) | 60 / 3.3 (295) | 60 / 2.2 (98) |

(At load average 15-18 earlier the same day, Ultra measured 21-24 fps at the cell row and guard
corridor before and 41-52 after the shadow cache and half-resolution volumetrics.)

Where Ultra's time went, by switching one feature at a time at 1a's cell row (`features`
overrides, `__enhanced.pipeline.build`): the two lamp cubes, six faces each every frame, were
2300 draws and about 30 ms of main-thread time (the frame was CPU-bound at 21 fps); then the
full-resolution volumetric march (29 → 56 fps at half resolution, with 40 steps kept) and three.js's
`DepthOfFieldNode` (36 → 56 fps without it; the one-pass soft focus that replaced it costs nothing
measurable). Half-resolution GTAO, 24 instead of 40 volumetric steps and 9 instead of 16 PCF taps
each moved the frame rate by less than the noise once those were gone, so Ultra keeps them.
What is left in the gas chamber is the main thread: about 560 scene draws behind the zone culler
(10 ms in three.js's render loop), the same at every tier.

Read the tiers this way:

- Low and Medium cost about as much as Original (both at the ceiling here).
- High adds TRAA, a lamp cube shadow and the 2048 moonlight map: at the ceiling.
- Ultra adds a second lamp cube, 40-step volumetrics, full-resolution 16-sample GTAO, the 4096
  moonlight map and the soft focus. At rest its lamp cubes cost only the faces where something
  moves; a character walking past a lamp redraws one to three faces a frame (the moving casters
  only, over a copied static face).

## Evidence

### Image checks (`tools/enhanced-compare.ts`, `tools/image-metrics.ts`)

`npx tsx tools/enhanced-compare.ts [--levels 1a,3a,6a] [--tiers medium,high,ultra] [--fps 3]`
starts a dev server and headless browser (or uses `--url` / `--cdp`), loads each level once in
Original (`?fly`) and once in Enhanced, sets the evidence poses through
`__view.controls.setPose`, refills the flashlight battery before every frame (a drained battery
dimmed the later tiers of the first strips), skips any scripted scene that takes the camera,
hides every overlay but the frame, and writes PNG frames and `metrics.json` to `--out`. Per
pose and tier it checks the Enhanced frame against the Original frame (display luma, Rec. 709):

| Check | Limit |
|---|---|
| Clipped white (luma ≥ 250) | ≤ 2 %, or ≤ the Original's share |
| Near black (luma ≤ 10) | ≤ Original + 12 points, and ≤ 60 % (or the Original's share) |
| Mean luma | 0.6-1.15 × Original, or within 6 levels of it |

Poses (`POSES` in the tool): 1a `cell-row`, `lamp-white` (bright white: the lamp and the
pale wall under the corridor lamp, flashlight off), `guard` (red alarm), `gas-wall` (bright
white: the pale tiles in the flashlight; shot before the gas chamber scene, after which the
chamber moves into that spot), `gas`, `electro`, `cell-dark` (dark room: inside a cell,
flashlight off), `close-floor` (the cell row floor in the flashlight, 1.9 m down the beam),
`close-bars` (a cell door at arm's length), `close-face` (Torque's face, external view, 0.8 m
from the head); 3a `yard`, `yard2`; 6a `woods`, `woods2` (foliage at the lens).

Before (commit 0c491eb) and after, each cell `mean ratio / near black % / clipped %`, ✗ =
fails a check. The 1a gas poses of the first run are n/a: its Original frames were stale or
caught the insanity vision, which the tool now skips.

| Pose | Original mean / black % / clip % | Before: Medium | High | Ultra | After: Medium | High | Ultra |
|---|---|---|---|---|---|---|---|
| 1a cell-row | 27 / 15 / 0.3 | 0.73 / 42 / 0.0 ✗ | 1.10 / 35 / 0.0 ✗ | 1.11 / 34 / 0.0 ✗ | 1.02 / 8 / 0.0 | 1.04 / 6 / 0.0 | 1.11 / 4 / 0.0 |
| 1a lamp-white | 36 / 10 / 0.0 | 0.72 / 34 / 0.0 ✗ | 0.53 / 48 / 0.0 ✗ | 0.50 / 49 / 0.0 ✗ | 0.92 / 6 / 0.0 | 0.90 / 7 / 0.0 | 0.91 / 5 / 0.0 |
| 1a guard | 65 / 5 / 2.0 | 1.29 / 12 / 0.0 ✗ | 1.25 / 15 / 0.0 ✗ | 1.25 / 15 / 0.0 ✗ | 0.85 / 5 / 0.0 | 0.85 / 1 / 0.0 | 0.88 / 1 / 0.0 |
| 1a electro | 36 / 14 / 0.0 | 1.29 / 20 / 0.1 ✗ | 1.31 / 21 / 0.0 ✗ | 1.33 / 21 / 0.0 ✗ | 1.05 / 5 / 0.0 | 1.07 / 4 / 0.0 | 1.09 / 3 / 0.0 |
| 1a cell-dark | 21 / 22 / 0.0 | 0.61 / 49 / 0.0 ✗ | 0.77 / 50 / 0.0 ✗ | 0.79 / 50 / 0.0 ✗ | 0.85 / 22 / 0.0 | 0.91 / 18 / 0.0 | 0.87 / 18 / 0.0 |
| 3a yard | 21 / 29 / 0.0 | 0.95 / 34 / 0.0 | 1.04 / 43 / 0.0 ✗ | 1.10 / 42 / 0.0 ✗ | 1.10 / 5 / 0.0 | 1.04 / 8 / 0.0 | 1.12 / 7 / 0.0 |
| 3a yard2 | 59 / 2 / 0.1 | 1.11 / 2 / 0.0 | 1.08 / 5 / 0.0 | 1.13 / 4 / 0.0 | 0.93 / 0 / 0.0 | 0.92 / 0 / 0.0 | 0.97 / 0 / 0.0 |
| 6a woods | 40 / 3 / 0.0 | 0.60 / 37 / 0.0 ✗ | 0.66 / 42 / 0.0 ✗ | 0.67 / 41 / 0.0 ✗ | 0.67 / 2 / 0.0 | 0.66 / 3 / 0.0 | 0.68 / 1 / 0.0 |
| 6a woods2 | 27 / 4 / 0.0 | 1.57 / 28 / 0.0 ✗ | 1.62 / 31 / 0.0 ✗ | 1.69 / 30 / 0.0 ✗ | 0.74 / 7 / 0.0 | 0.74 / 7 / 0.0 | 0.77 / 5 / 0.0 |
| 1a gas-wall | 66 / 1 / 0.2 | 2.14 / 21 / 0.0 ✗ | 2.18 / 22 / 0.1 ✗ | 2.19 / 22 / 0.1 ✗ | 0.79 / 1 / 0.0 | 0.78 / 1 / 0.0 | 0.78 / 3 / 0.0 |
| 1a gas | 15 / 12 / 0.0 | 0.70 / 53 / 0.0 ✗ | 2.68 / 31 / 0.0 ✗ | 0.92 / 48 / 0.1 ✗ | 1.38 / 4 / 0.0 | 1.30 / 6 / 0.0 | 1.29 / 6 / 0.0 |

After: all 44 Enhanced frames (Low to Ultra) pass. No frame clips (0.0 %) where Original clips
up to 2 %. Near black falls from 30-50 % to 1-22 % (the dark cell keeps the Original's 22 %).
High and Ultra now match Medium within a few percent.

**Flashlight start and the performance work** (2026-10-23; before = commit 34ef721, after; each
cell `mean ratio / near black %` at Low, Medium, High, Ultra; frames in
`scratchpad/enhpolish/before/` and `after/`, `metrics.json` in each):

| Pose | Original mean / black % | Before: Low · Medium · High · Ultra | After: Low · Medium · High · Ultra |
|---|---|---|---|
| 1a close-floor | 29 / 0 | 1.45/8 ✗ · 1.46/8 ✗ · 1.46/7 ✗ · 1.51/6 ✗ | 1.11/11 · 1.11/10 · 1.12/10 · 1.12/10 |
| 1a close-bars | 33 / 18 | 1.48/1 ✗ · 1.47/1 ✗ · 1.44/1 ✗ · 1.44/1 ✗ | 0.71/18 · 0.72/15 · 0.69/13 · 0.62/13 |
| 1a close-face | 32 / 7 | 1.30/12 ✗ · 1.36/11 ✗ · 1.17/11 ✗ · 1.43/9 ✗ | 0.81/18 · 0.83/17 · 0.79/18 · 0.80/16 |
| 1a gas-wall | 66 / 1 | 0.79/1 · 0.79/1 · 0.79/1 · 0.78/3 | 0.78/1 · 0.78/1 · 0.78/1 · 0.77/3 |
| 1a gas | 15 / 12 | 1.35/5 · 1.35/4 · 1.27/7 · 1.27/7 | 1.29/6 · 1.30/5 · 1.22/8 · 1.25/5 |
| 1a electro | 36 / 14 | 1.06/5 · 1.08/4 · 1.07/4 · 1.08/3 | 1.05/5 · 1.07/4 · 1.07/4 · 1.07/4 |
| 1a guard | 68 / 5 | 0.81/6 · 0.80/5 · 0.81/1 · 0.83/1 | 0.80/8 · 0.82/5 · 0.83/1 · 0.81/1 |
| 1a lamp-white, cell-dark | 36 / 10, 21 / 22 | all pass (0.86-0.92) | all pass (0.83-0.91) |
| 3a yard, yard2; 6a woods, woods2 | | all pass | all pass (0.64-1.06) |
| 1a cell-row | 17 / 26 | 1.27/14 · 1.68/8 ✗ · 1.72/6 ✗ · 1.83/4 ✗ | 1.18/16 · 1.61/9 ✗ · 1.69/7 ✗ · 1.74/5 ✗ |

The close-ups pass now at every tier, and no other pose changed by more than a few percent. The
cell-row failures are the harness's, before and after alike: a corridor ceiling lamp of the cell
row is off for the first seconds after the level starts and the Original and Low frames are shot
in that time (Original 16.6 here, 27.4 in the texture evidence, shot later); the Medium to Ultra
frames show it lit.

### Strips

The frames are not in the repository because they are made from the game's data. Session
scratch `scratchpad/enh2/strips/`: `all.jpg` (after; every pose, Original | Low | Medium |
High | Ultra), `before-all.jpg` and `before-new-poses.jpg` (commit 0c491eb), and
`1a-gas-glass-medium.jpg` (the gas chamber window during its scene: the glass stays green).
The first strips are in `scratchpad/enhanced/strips/`.

What the strips show:

- Enhanced is a little darker and colder than Original and reads as a haze-filled, physically
  lit version of it: the darks read as in Original, pale walls under lamps or the flashlight stay
  surfaces (no bloom), lamps and glow-marked glass glow with their hue.
- The flashlight is a broad, soft torch with real shadows (bars, pillars) and wet specular floors,
  dimmer at the hot spot than Original's clamped beam.
- The authored lamp positions, the red alarm and the fog colour all survive.

## Texture enhancement

Sharper, more detailed surfaces in Enhanced mode, built on the user's machine from the user's own
textures. Nothing of it is in the repository or the build.

### The cache (`npm run enhance-textures`, `tools/enhance-textures.ts`)

The tool reads every texture of the install (all 38 packages but the interface's), works out how
each is drawn and writes a cache next to the converted media, `game/converted/enhanced/`
(gitignored with the rest of `game/`). Generators: `src/app/enhanced/maps/generate.ts`.

| Map | File | Made from |
|---|---|---|
| Albedo, upscaled ×2 (`--scale 4` possible) | `tex/<pkg>/<id>.a.webp` | edge-aware upscale (below); sources of 512 and up are kept as they are |
| Normal map, at the upscaled size | `tex/<pkg>/<id>.n.webp` | relief from the albedo's luma, strength per material class |
| Surface: R roughness, G specular, B cavity | `tex/<pkg>/<id>.s.webp` | colour, relief and material class, at the source's size |
| Manifest | `manifest.json` | key `pkg:id` → files, sizes, class, fingerprint |

- **Upscale** [port]: a Catmull-Rom bicubic, clamped to the range of the four nearest source texels
  (no ringing or halo), blended where the local structure tensor finds one dominant edge towards
  a steering kernel (an anisotropic Gaussian, σ 1.1 texels along the edge and 0.42 across it).
  Edges lose their staircase and stay crisp without any sharpening filter. Texel centres are
  exact (output texel j samples the source at (j + ½) / s − ½), every filter wraps (the renderer
  tiles every texture), and colour is interpolated premultiplied by alpha, so cut-out bars and
  foliage get no dark fringe from the black that DXT1a stores under alpha 0. No ML model is used.
- **Relief**: luma band-passed between about one source texel and six (the baked shading across a
  texture does not become a slope, DXT block noise does not become bumps), soft-clipped at
  ±0.12 so a hard paint edge (a checkered floor, a sign) is not a cliff. Dark is low.
- **Normal map convention** [verified by test]: red is +u, green is +v in the engine's *stored*
  row order (row r is v = (r + ½) / height with `flipY = false`), blue up. That is the frame
  `shading.ts surface()` builds from screen derivatives (T = ∂P/∂u, B = ∂P/∂v; three.js's
  `dFdy` is y-up on both backends, WGSL `- dpdy`), so nothing is flipped anywhere. The test
  mirrors the cotangent frame on the CPU: a rise in u or v tilts the normal away from the uphill
  side, mirrored UVs included.
- **Material class** [inferred]: the tool scans every `.odu` material and every skinned model.
  Textures on skinned models are `character`; a layer drawn over an environment-reflection pass
  (mode 7) carries the original's own reflection mask in its alpha (`metal` when not saturated,
  and the mask is used per texel); the Landscape Textures package is `ground`; colour statistics
  give `foliage` (green, cut-out), `wood` (brown with a coherent grain) and `metal` (grey with a
  partial-alpha mask); everything else is `stone` (concrete, brick, tile, plaster). Of 4188
  textures: 3407 stone, 302 character, 164 foliage, 118 metal, 116 wood, 81 ground.
- **Roughness / specular** [inferred, by eye]: a class base (stone 0.74, ground 0.86, metal
  0.48, wood 0.72, foliage 0.66, character 0.82) moved by the local brightness (stone: darker is
  damp and glossier; metal: brighter is polished), rougher in crevices, never below 0.18 (low
  resolution relief with a mirror finish sparkles). Per texel: skin tones on characters 0.52,
  rust matt (≥ 0.86, specular ×0.55), the reflection mask glossier and more specular. Specular
  (0.5 reads as shading.ts's 4 % dielectric) × cavity^1.5.
- **Cavity**: how far a texel sits below its 1.5-texel neighbourhood (small scale only: a large
  dark patch is paint or dirt, not a hole). It is already applied to the specular; the B channel
  keeps it for later passes (SSR, AO).
- **Skipped**: textures only ever drawn as effects (additive, subtractive, modulate passes),
  environment maps or animation frames (347), and the interface package.
- **Incremental**: an entry is regenerated only when its fingerprint changes (SHA-1 of the
  source payload, generator version, scale, codec, usage flags). Files are written as `.part`
  and renamed; stale files are removed. `--only`, `--limit`, `--force`, `--jobs`, `--data`,
  `--out`.
- **Codec**: WebP through `cwebp` (libwebp, BSD) when it is on the PATH (or `$CWEBP`): albedo
  q 90 with lossless alpha, normals q 92 (the shader renormalises them), surface q 90. Without
  it, PNG (about six times the disk). The encoder runs as asynchronous child processes of the
  main thread: `spawnSync` from worker threads hung on its stdin.

Full install on the development Mac (4 worker threads, load average around 14 from other jobs):
**4188 textures in 6 min 8 s (1053 s of worker time), 144.9 MB** (albedo 63.3, normal 42.3,
surface 39.3). A second run with nothing changed takes 1.5 s.

### Run time (`src/app/enhanced/maps/runtime.ts`)

`EnhancedRenderer.maps` (an `EnhancedTextureMaps`) installs two hooks in
`surface-material.ts enhancedTextures` (unset in Original):

- `maps(key)`: the `EnhancedMaps` of the first lit, mesh-UV layer of a surface (an
  environment-reflection base is skipped, so the mode-7 diffuse over it gets the maps, sampled
  with its own coordinates). `createSurfaceMaterial` uses it when the options carry no
  `enhancedMaps`.
- `texture(key, cutout, base)`: the upscaled albedo in place of the texture Original draws. It
  only changes the texture in the material's slot, never the shared graph. Characters
  (`character.ts`) and the player's reputation skins (`reputation-skin-system.ts`) use it too.
- `layout()` and `bind(material, key)`: characters' normal and surface maps. Characters are lit
  through `engineLightMaterial`'s one shared graph per lighting kind (no graph per texture), so
  the maps come through a slot of their own: `engineLightMaterial(m, { …, enhancedMaps:
  layout })` builds (once per layout) a graph that samples `material.enhancedMapTextures.normal`
  / `.surface` of the material drawn, and `bind` sets those to the texture key's cached maps
  (neutral 1×1 stand-ins without an entry; a clone, which three.js copies without custom fields,
  reads the stand-ins too). A skin change (`reputation-skin-system.ts`) binds the new key's maps
  with its albedo. No detail maps on characters (concrete relief, not cloth or skin). Without the
  Enhanced hooks (Original) the option is ignored and the graph is the one it always was. The
  maps change what Enhanced lights per pixel (flashlight, lamp specular and shadows); evidence:
  `scratchpad/enhpolish/chars/` (Torque, a CartWheeler: maps on | normal strength 0).

**Fragment texture limit.** A WebGPU fragment shader may bind 16 sampled textures
(`maxSampledTexturesPerShaderStage`'s default; three.js asks for no more, and many adapters
have no more). A lit Enhanced surface binds one texture per layer and splat, the Enhanced
shadow maps (3: flashlight, two lamp cubes; `enhancedShading.textures`), the projected character
shadows (4, `ENGINE_SHADOW_TEXTURES`), and its maps: normal 1, surface 1, detail 2
(`EnhancedMaps.detail`). Layered surfaces of 1a went to 17-18 and their pipelines failed to
build ("number of sampled textures exceeds the per-stage limit"): the surfaces were not drawn.
`createSurfaceMaterial` now fits the maps into what is left (`fitEnhancedMaps`), dropping the
detail maps first, then the surface map, then the normal map. `tests/enhanced-texture-limit.test.ts`
builds every surface of the 18 retail levels at each tier (every texture given a full cache
entry) and checks the count; `npm run smoke` loads 1a at Ultra and fails on any WebGPU error;
`tools/levelqa.ts --all --query "gfx=enhanced&tier=ultra"` (and High) loads every level with
zero errors. In 1a at Ultra the largest fragment stage is now 16 textures (it was 18).

Per tier (`maps/manifest.ts TIER_MAPS`):

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Normal maps | | at the source's size | at the source's size | at the upscaled size |
| Roughness / specular / cavity | | | yes | yes |
| Upscaled albedo | | | yes | yes |
| CC0 detail maps | | | yes | yes |
| Anisotropy | | 8 | 16 | 16 |
| Budget (GPU, RGBA8 with mips) | 0 | 128 MB | 448 MB | 1 GB |

- The tier at a level's load decides (the maps are part of a material's shader structure); a
  tier change applies from the next level. `main.ts` calls `maps.prepareLevel(fs, level)` before
  the meshes are built, which fetches and decodes the level's own maps (at most 6 s; the rest
  swaps in as it arrives), so they are drawn enhanced from the first frame.
- Objects built later (characters, props, doors) load on first use: their maps start as neutral
  1×1 stand-ins and their albedo as a copy of the original, swapped in place when the file
  arrives (`dispose()`, new image: three.js recreates the GPU texture at its new size on the next
  draw).
- Budget: a level's own surfaces take at most 80 % of it (`LEVEL_SHARE`), largest first; the rest
  is kept for what is built later. A texture turned away stays as in Original for that level.
  Measured: 1a takes 371 MB at High (477 textures; about 72 MB as originals) and 54 MB at
  Medium; at Ultra 3a takes 314 MB and 6a 420 MB. Nothing was turned away on these levels.
- Normal maps are decoded at the tier's size by the browser (`createImageBitmap` resize);
  everything is decoded off the main thread as an `ImageBitmap` (straight alpha, no colour
  management) and mip-mapped on the GPU. Cut-out albedo keeps `toDataTexture`'s
  coverage-preserving mip chain (CPU, from the decoded pixels).
- Shading (a wrapper around `shading.ts surface()`, nothing in shading.ts changed): the normal map
  through `uniforms.normal` (0 flattens it: the live A/B switch), roughness = R × EU.roughness /
  0.68 and specular = G × EU.specular / 0.55, so the lighting's own tuning still applies, and
  up-facing surfaces keep the wet-floor drop (`uniforms.wetFloor`, floorRoughness / roughness)
  that shading.ts's heuristic gives surfaces without maps. Roughness and specular come from one
  sample of the surface map.
- Silent fallback: no cache (the tool has not run, or `?texmaps=0`), no entry, a failed fetch,
  Low, or the budget: the surface is built exactly as without the hooks (same shared graph: the
  Original guard test checks it).
- QA: `__enhanced.maps` (`available`, `stats`, `bytes`, `slots`, `detail`, `uniforms`).

Normal maps only change what Enhanced lights per pixel (the flashlight, the specular lamps, the
lamp shadows' share): the authored per-vertex light is the same, so a surface out of the
flashlight changes little apart from its sharper albedo.

### Detail maps (optional, CC0: `npm run enhance-detail`, `tools/enhance-detail.ts`)

One fine concrete relief and roughness, blended over the generated maps on High / Ultra at 4
repeats per repeat of the surface's texture (`uniforms.detailTile`), weight 0.5
(`uniforms.detail`) times smoothstep(0.35, 0.75, roughness), so rough stone and earth take it
fully and glossy metal and skin less: a whiteout blend in tangent space plus ±40 % roughness
breakup. Without the files the stand-ins change nothing.

| Asset | Files | Source | Licence |
|---|---|---|---|
| Concrete Wall 008 (Dario Barresi, Charlotte Baglioni) | `concrete_wall_008_nor_gl_1k.jpg` (MD5 ea22029834a78f549981196b3263aa78), `concrete_wall_008_rough_1k.jpg` (MD5 1f6d5b02c58aff38a69f07a62a4cc231) | https://polyhaven.com/a/concrete_wall_008, files from `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_wall_008/` | CC0 1.0 (https://polyhaven.com/license) |

The script downloads them without an account into `game/converted/enhanced/detail/`, checks the
MD5 the Poly Haven API lists, and records the source and licence in `detail.json`. The normal map
is OpenGL convention (+Y towards the image's top row, which is −v here): its green is flipped.

### Evidence

Original | Enhanced High without maps (`?texmaps=0`) | Enhanced High with maps, same poses, 1280×583, in
the session scratch directory `scratchpad/enhtex/evidence/` (`<level>-<pose>-<mode>.png`,
`texcompare.json`), with strips and full-resolution crops in `scratchpad/enhtex/strips/`. Poses:
1a cell row, guard corridor, gas chamber; 3a yard; 6a woods; close-ups in 1a of the tiled gas
chamber wall, the cell row floor, the cell bars and Torque's face (the player model shown with
`setExternalView`, camera 0.8 m in front of the head bone).

Image checks (`tools/image-metrics.ts`; display values, mean / clipped % / near-black %):

| Pose | Original | High, no maps | High, maps |
|---|---|---|---|
| 1a cell row | 27.4 / 0.28 / 14.6 | 28.8 / 0 / 5.7 | 28.7 / 0 / 6.7 |
| 1a guard corridor | 67.6 / 1.97 / 5.3 | 56.8 / 0 / 0.8 | 56.2 / 0 / 0.8 |
| 1a gas chamber | 15.1 / 0 / 11.7 | 19.6 / 0 / 6.0 | 19.6 / 0 / 6.2 |
| 3a yard | 21.2 / 0.01 / 29.3 | 21.9 / 0 / 8.0 | 21.9 / 0 / 8.1 |
| 6a woods | 39.9 / 0.01 / 3.2 | 26.1 / 0 / 3.3 | 26.2 / 0 / 3.2 |
| 1a wall close-up | 65.8 / 0.24 / 2.3 | 51.0 / 0 / 3.7 | 50.4 / 0 / 4.0 |
| 1a floor close-up | 28.6 / 0 / 0 | 41.5 / 0 / 7.6 | 41.3 / 0 / 8.1 |
| 1a bars close-up | 32.6 / 0.15 / 17.7 | 46.8 / 0 / 0.8 | 46.1 / 0 / 1.2 |
| 1a Torque's face | 32.1 / 0 / 6.7 | 43.2 / 0 / 10.1 | 38.4 / 0 / 11.9 |

The maps move no pose's mean by more than a level (the face's pose follows the idle animation, so
it differs between page loads; the upscaled albedo's mean equals the source's to 0.1 level), clip
nothing and change the near-black share by at most 1.8 points: no pushed highlights, no crushed
blacks. The five evidence poses pass `checkFrame` with and without maps. The floor, bars and face
close-ups fail its mean ratio (1.2-1.45 × Original) with and without maps alike: the flashlight
at arm's length (the lighting's, not the textures').

Frame rate with maps (fps over 3 s, headless Brave, same machine and caveats as Performance;
"no maps" switches the tier live on a `?texmaps=0` load, "maps" loads the level at that tier):

| Pose | Original | Low | Medium (no maps / maps) | High (no maps / maps) | Ultra (no maps / maps) |
|---|---|---|---|---|---|
| 1a cell row | 60 | 60 | 60 / 60 | 56 / 50 | 21 / 21 |
| 1a guard corridor | 60 | 59 | 59 / 60 | 43 / 45 | 23 / 24 |
| 1a gas chamber | 60 | 60 | 60 / 60 | 60 / 60 | 37 / 29 |
| 3a yard | 48 | 60 | 58 / 58 | 51 / 41 (three samples each, a second pair of loads) | 36 / 43 |
| 6a woods | 60 | 55 | 60 / 60 | 60 / 53 | 55 / 50 |

Medium's normal maps cost nothing measurable. High's full set costs up to about 20 % where the
frame is fill-bound (3a's yard: 41 against 51 fps in back-to-back loads) and nothing in the
enclosed rooms; Ultra is dominated by its shadows and volumetrics. The run-to-run noise on this
loaded machine is ±6 fps.

## Gore (`src/app/enhanced/gore/*`)

Enhanced makes the game's own blood read as grounded and grim instead of painted on. It keeps to
what the game already shows (the blood of blows, Blood Point Generators, BloodPools, the Part Cap
stumps and their spurts, gibs, the blood fountains such as the 1a guard's mouth blood) and adds
physical behaviour: dark, wet films that dry, heavy drops that fall and leave stains shaped by
their impact, pools that spread, stains that soak into clothes. Nothing new is depicted.

### How it hooks in (Original untouched)

The game's blood events go through a listener slot, `src/game/fx/gore-bus.ts`
(`gore.listener`). Original never sets it, and every call site is `gore.listener?.x?.(...)`:
a no-op that returns undefined, so the faithful code path runs as before. Where a handler returns
true it has drawn the blood itself, and the faithful splat is skipped.

| Call site | Event | Enhanced draws |
|---|---|---|
| `fx/system.ts bloodNear` (player blows, `effect('blood')`) and the NPC / hazard `damage` spray | `hit(point, dir, amount)` | droplets, the impact spatter behind the body (or on the floor where the spray comes down), a drip under the wound, a wound on the body |
| `fx/effects.ts` Blood Point Generator | `spray(values, M)` | droplets with the template's elevation, reach and spread |
| `fx/effects.ts` BloodPool | `pool(point, normal, size, grow, opacity)` | a pool spreading over its grow time |
| `actors/dismember.ts` cut (with effects) | `cut(bone, body, dir)` | arterial pulses from the stump for 7 s, a wound at the stump |
| `actors/system.ts gibBody` | `gib(M, body)` | a burst of drops, spatter and cast-off on the floor and walls around, a pool |
| `world/fx.ts addFountain` (lit fountains, p46 = 3) | `fountain(emitter, textures)` | blood ones (p33 × the texture's mean colour clearly red): a darker tint (`Emitter.goreTint`), drops where their particles cross the floor, a small pool after eight, a wound where the fountain sits on a body |
| `fx/system.ts` level start / update / dispose | `attach(env)`, `update(dt)`, `detach()` | the per-frame part: pools under the dead, trails, spurts, drips, the hurt view |

`tests/enhanced-gore.test.ts` guards it: the slot is null without Enhanced, `gore-bus.ts`
imports types only, nothing outside `src/app/enhanced` imports the gore modules, and every call
site goes through the optional slot. `?gore=0` runs Enhanced without its gore (QA: the before
frames).

### What it draws

- **Films** (`decals.ts`): spatters, drops, trails and pools are projected onto the level's drawn
  triangles exactly as `fx/decals.ts` projects the original's decals (`Decals.project`: clipped to
  the decal box, wrapping steps and corners; dynamic bodies such as doors get none, as in the
  original). All films of a kind share one vertex buffer recycled as a ring (`ring.ts`): one draw
  call and one shader for every splat. Each vertex carries its birth time, so colour, coverage,
  gloss and drying are computed in the shader with no per-splat uniforms. The films are lit
  through the documented hooks: `engineLitColor` with the baked light under the splat as the
  vertex colour, the per-pixel flashlight, lamp shadows and GGX specular with the film's own
  roughness, specular and relief normal (a surface-gradient bump of the film thickness; no
  tangents). They draw first among the transparent passes (`renderOrder` -1), so smoke, glass
  and particles in front blend over them.
- **Blood model** (`blood.ts`, the CPU twin of the shaders): a thick fresh film is near black-red
  (linear albedo 0.075, 0.0035, 0.003), a thin one redder (0.2, 0.02, 0.016), with a water film on
  top (roughness 0.1, full specular) that catches the flashlight. Dryness is
  `1 − exp(−age / (110 s × (0.25 + thickness)))`: a thin spatter is matte brown-black within two
  minutes, a pool's centre stays wet for many. Dried thin films fade a little; crusts stay. A
  drop landing at angle α leaves an ellipse of width / length = sin α (the bloodstain-pattern
  rule), its tail pointing the way it flew (`impactShape`); fast drops spread wider
  (`stainSize`). Pools spread from the centre outwards in the order of the atlas' arrival
  channel, `1 − exp(−(age − 0.4 s) / τ)` with τ 14-22 s for the dead, the template's grow time for
  BloodPools.
- **Splat atlas** (`splats.ts`): generated in code at level load (about 0.3 s, seeded): 16 tiles
  of 256²: six impact spatters (a scalloped main stain, satellites in a downstream cone that grow
  smaller and longer with distance, mist), four round drops, four pools (lobes, arrival order),
  two cast-off lines. Channels: thickness, pool arrival, slow variation (clots, uneven drying).
- **Droplets** (`droplets.ts`): drops of 0.7-6 mm, ballistic with gravity and quadratic drag
  (terminal speed 2-9 m/s by size), ray-cast against the collision world each step; a landing
  drop paints a stain. One instanced draw: each drop is an impostor stretched along its screen
  motion over 1/60 s, at least ~1.3 px wide (a thinner one keeps its energy through its alpha),
  shaded as a small sphere: baked light where it started, the flashlight (with its shadow) and a
  GGX glint.
- **Wounds** (`wounds.ts`): a wounded body gets two skinned overlays on its own geometry and
  skeleton. A wound is the bind-pose position of the vertex nearest the hit, so it rides the skin
  through every clip. Per fragment the overlays measure the rest-pose distance to each wound (up to
  8 per body): a dark core, a stain soaking outwards to 1.7× over about 22 s, reaching further
  downwards, with a ragged edge (3D noise). Blood dyes what it soaks: the first overlay multiplies
  the body's own colour by the blood's transmission (blend dst × src: a white vest turns crimson,
  the navy uniform near black, skin dark red), the second adds only the wet stain's specular
  (`engineLitColor` of a black albedo with the body's light set). The wound data are per-object
  uniforms read from the overlay being drawn: every body shares the two shaders. The overlays
  follow Part Cap index swaps.
- **Per frame**: a pool under each body that dies after blood was drawn on it, after a cut, or by
  a scripted kill (bodies placed dead keep the level's own blood decorations); drops under the
  bleeding (Part Cap bleed, or bloodied and under a third of their health; posed bodies do not
  bleed, as `dismember.ts`), every 0.45 m or, standing, a few at 1.6 s; blows on one body within
  0.15 s (shotgun pellets, a hazard every frame) add a quarter.
- **Hurt view** (`screen.ts`, `'beforeGrade'` stage): below 40 % health the edges of the view
  close in towards a deep red-black with a ragged, slowly drifting rim and a slow pulse, plus a
  short flare on each blow. No drops on the lens, no full-screen red.

### Budgets per tier (`config.ts`)

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Films alive (spatter ring, vertices) | 96 (6 144) | 192 (12 288) | 320 (20 480) | 512 (32 768) |
| Pools alive (vertices) | 4 (3 072) | 8 (6 144) | 12 (9 216) | 16 (12 288) |
| Wounded bodies × wounds | 3 × 4 | 6 × 6 | 10 × 8 | 16 × 8 |
| Droplets alive / per blow | 96 / 6 | 192 / 10 | 384 / 16 | 640 / 24 |
| Landing drops that stain | 35 % | 50 % | 60 % | 70 % |
| Trails, film relief | no, no | yes | yes | yes |

The buffers are sized once for Ultra; a tier change only moves the ring's limits (the oldest
films beyond them are cleared). The oldest film is always the one recycled. Draw calls: two for
the films, one for the droplets, two per wounded body.

### Performance

Headless Brave on the loaded development Mac (other agents' browsers running), 1a, the corridor
after the staged fight below (shiv kill, revolver hit, a cut, a gib: the film rings at their
budgets), frame probe over 9 s per tier, Ultra first (2026-10-23):

| fps (p95 ms) | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Gore on | 59.8 (16.8) | 60 (16.8) | 53.1 (33.3) | 27.3 (50.1) |
| `gore=0` | 60 (16.7) | 60 (16.7) | 55.2 (16.8) | 46.1 (33.4) |

Low to High stay within the noise of this machine (another run gave High 52.4 with gore, 52.1
without). Ultra swung between 20 and 46 fps without gore across three runs, so its row says
little; the gore's GPU work is two blended film draws, one instanced droplet draw and the wounded
bodies drawn twice more.

### Evidence (Enhanced High; before = `gore=0`)

Session scratch `scratchpad/enhgore/ev/` (not in the repository: frames of the game's data):

- `before/`, `after/`: the 1a scripted scenes by play (`tools/playthrough.mjs --level 1a`,
  then the route's own `1a.guards` / `1a.shiv` steps): the guard stabbed in the head through the
  bars (scene 5824 at 3.5-12 s: the mouth blood darker and soaking into his collar and shirt,
  drips and a small pool under him) and the inmate killed on his bed by pulling the shiv
  (`slick-fly`: the pool soaking into the mattress). `guard-strip.jpg` (top before, bottom after).
- `stage-before/`, `stage-after/`, `staged-before-after.jpg`: staged on the real game paths in
  1a: a revolver hit (`__weapons.service.fire`), a shiv kill on a CartWheeler (four swings), a
  dismemberment (`__actors.parts.capLimb`, the cut with its effects) and a gib (a claw blow,
  damage type 8, on the corpse).

Image checks (`tools/image-metrics.ts`, each Enhanced-with-gore frame against the same frame with
`gore=0`; mean luma / near black % / clipped %):

| Frame | gore=0 | gore | ratio | check |
|---|---|---|---|---|
| guard 6.2 s | 16.3 / 42.8 / 0.00 | 16.1 / 43.6 / 0.00 | 0.99 | pass |
| guard 7.2 s | 20.0 / 29.9 / 0.00 | 19.9 / 29.9 / 0.00 | 1.00 | pass |
| guard 9.2 s | 15.7 / 43.6 / 0.00 | 15.9 / 43.9 / 0.00 | 1.01 | pass |
| inmate on the bed | 25.3 / 5.3 / 0.00 | 25.0 / 5.7 / 0.00 | 0.99 | pass |
| shiv kill (pool after 13 s) | 59.6 / 1.3 / 0.00 | 63.4 / 0.9 / 0.00 | 1.06 | pass |
| cut | 45.7 / 0.9 / 0.02 | 38.4 / 0.3 / 0.03 | 0.84 | pass |
| gib (6 s) | 55.7 / 1.0 / 0.00 | 57.5 / 0.6 / 0.00 | 1.03 | pass |
| revolver hit | 50.1 / 0.0 / 0.01 | 59.1 / 0.0 / 0.01 | 1.18 | mean ✗ |

The blood neither clips (at most 0.03 % white, from the flashlight's glint) nor crushes the frame
(near black never rises by more than 0.8 points). The revolver frames differ by the red alarm's
1 Hz phase and the guard's turn between the two runs, not by the blood; the staged pairs are
separate page loads, so the actors' reactions differ a little.

## Extension points

- **Material maps** (texture enhancement): `SurfaceMaterialOptions.enhancedMaps =
  { normal?, roughness?, specular?, normalScale? }` (`engine-light.ts EnhancedMaps`). They are
  sampled with the base layer's own coordinates and become part of the shared graph's structure
  (`em:nrs` token), so every surface with the same maps layout shares one shader. Normal maps are
  tangent space, applied with a cotangent frame from screen derivatives because the engine's
  meshes carry no tangents; the green channel is +v in stored rows (see Texture enhancement).
  Roughness and specular read the red channel. Without explicit maps, `createSurfaceMaterial`
  asks `surface-material.ts enhancedTextures` (the generated cache, installed by
  `maps/runtime.ts`). Per-material scalars that need no rebuild:
  `material.enhancedParams = { roughness, specular }` (−1 means the heuristic). The prototype
  defaults are installed in Enhanced mode only.
- **Post stack**: `__view.enhanced.addStage(stage, (color, { depth, camera, features }) => node)`
  inserts a node at `'sceneHDR'` (decals, gore in HDR before AO), `'beforeBloom'`,
  `'beforeGrade'` or `'final'`. It returns a remover. The chain rebuilds itself.
- **Decal layers**: decals drawn as scene meshes are lit by the same hooks. Blended decals get the
  Enhanced fog and specular automatically. For screen-space decals, use the `'sceneHDR'` stage
  with the depth node.
- **Lights**: anything that feeds the engine light rig (`engineLights.addProvider`,
  `addSpotProvider`, `addDirectional`, a three.js PointLight in the scene) is picked up by
  Enhanced as well: specular, volumetric halos, possibly a cube shadow.
- **Game events** (gore): `src/game/fx/gore-bus.ts` `gore.listener` receives the blood events
  (see Gore); Original never sets it.
- **Debug / QA**: `__enhanced` (tier, setTier, features, governor, probe, shadows.stats,
  uniforms, `gore.info()`) and `__enhanced.pipeline.debugView = 'scene' | 'hdr' | 'ao' | 'volumetric' | 'vm'`
  followed by `pipeline.build(__enhanced.features)`.

## Licences

All Enhanced content is generated in code: the lens cookie, the dust noise (MaterialX Perlin from
three.js), the grain (interleaved-gradient noise) and the grade. The Enhanced mode downloads no
third-party assets (HDRIs, LUTs or noise textures) and stores none in the repository. The gore's splat atlas, its noise and its
blood model are generated in code as well (no blood textures, photos or decals are downloaded).
It uses three.js r186 (MIT), including its TSL display nodes `GTAONode`, `BloomNode`, `TRAANode`,
`FXAANode` (the soft focus is its own). Nothing derived from the game data is written anywhere by the
renderer.

Texture enhancement is the exception, by design and on the user's own machine:
`npm run enhance-textures` writes maps derived from the user's install into the gitignored
`game/converted/enhanced/`; nothing of it is committed, uploaded or downloaded. The optional
`npm run enhance-detail` downloads one CC0 asset from Poly Haven (source, files, MD5 and licence
in "Detail maps" above) into the same cache. The upscaler and every generator are code in this
repository; no ML model or third-party image library is used. `cwebp` (libwebp, BSD licence)
encodes the cache when it is installed.

## Limits and next steps

- Texture enhancement: lightmap textures are baked into the cache too (the usage scan does not
  read the levels' parts): a small share of it. The material classes come from heuristics; a per-texture
  override table would fix the odd misclassified texture.

- Screen-space reflections (`TierFeatures.ssr`) are not wired yet. Wet-floor specular carries the
  look for now. The `SSRNode` needs a roughness/metalness MRT output, which the texture work's
  maps would feed.
- Precompile: the passes are compiled at a level's load. After a tier change mid-level the new
  chain's passes compile on first sight until the next load; so do objects created after the
  load (their materials are usually shared with something compiled).
- The lamp-occlusion estimate subtracts the engine formula's share from baked light, so a lamp
  whose light was already baked dark can darken more than the original did. It is capped at 65 %
  of the authored light (`SHADOW_KEEP`).
- The red-alarm Lighting Effect, flicker and switching come through the engine rig, so Enhanced
  follows them frame by frame. An alarm shot can catch either phase of its 1 Hz wave.
