# Enhanced graphics mode

An optional modern renderer that sits next to the faithful one. **Original** stays the default.
It is the engine's look, byte for byte: gamma back buffer, vertex lighting, linear gamma fog, no
post stack. **Enhanced** answers a thought experiment: how dark, modern and disturbing can this
game look in 2026, using lighting that scales with the GPU, without turning cheesy? It keeps the
level's authored mood (its own lights, light regions, flicker, alarms and fog) and re-renders it
with physically based light, real shadows, volumetric scattering and a filmic horror grade.

Code: `src/app/enhanced/*`, with small gated hooks in `engine-light.ts`, `surface-material.ts`,
`renderer.ts`, `game/insanity/effects.ts` and the menu (`menu/graphics.ts`, `menu/gui-adapter.ts`).

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
  `toLinear(toSrgb(rgb) × shadow)` expression moved into a function.
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
        -> depth of field          (Ultra)
        -> lens + horror grade + AgX + grain  (post.ts gradeNode)
        -> FXAA                    (Low / Medium)
        -> sRGB (canvas) or linear (insanity effects' scene target)
```

### Lighting (`shading.ts`, installed into `engine-light.ts enhancedShading`)

Every lit material in the port is engine-lit: texture × the engine's light L (light units, per
vertex, gamma). Enhanced keeps L as the surface's authored lighting (baked vertex colours,
Ambient Light regions, Directional Lights, Point Lights from Light Housings and Lighting Effects,
flicker, the red alarm wave) and adds light on top in linear HDR:

- `E = max(L − lamp occlusion, 0)^2.2 + flashlight irradiance`, then
  `factor = ½ · E^(1/2.2)` back into the pass maths. No clamp: lamps and the flashlight's hot
  spot exceed 1 and bloom. A surface no Enhanced light reaches reads as authored.
- **Flashlight**: a per-pixel physically based spot replaces the rig's per-vertex beam
  (`engineLights.perPixelFlashlight`). Cone 9° inner / 26° outer plus a 55° spill. Fall-off is
  `POWER / (d² + 5)`, a soft near field because a reflector is not a point source. A generated
  lens cookie gives a hot centre and a faint reflector ring. Battery dimming comes through the
  SpotLight's intensity. It has a shadow map and GGX specular.
- **Specular**: GGX (height-correlated Smith, Schlick) from the flashlight and the
  `specularLights` strongest lamps near the camera. Fire, muzzle flashes and sparks count as lamps
  too. Up-facing surfaces are glossier (`floorRoughness` 0.38: wet floors). Elsewhere roughness
  is 0.68.
- **Lamp shadows** (High: 1 lamp, Ultra: 2): the strongest nearby engine point light gets a cube
  shadow map. Where it is occluded, that lamp's share of L (the engine's own formula,
  `colour · min(I/d², 2) · N·L`) is taken out, so cell bars and characters cast hard shadows from
  corridor lamps onto baked lighting.
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
texture's alpha. Blended surfaces, sprites, points and lines cast nothing. The zone culler's
choice for the frame applies (same camera layers).

| Map | Kind | Update |
|---|---|---|
| Flashlight | perspective, 65° | every frame |
| Lamps (1-2) | cube | all 6 faces when the lamp changes, then `lampFacesPerFrame` faces per frame, round robin |
| Moonlight | orthographic 80 m box around the camera, snapped to its texels | every frame |

PCF uses a Vogel disk rotated by interleaved-gradient noise (`shadowTaps`). TRAA resolves the
noise.

### Volumetrics (`volumetric.ts`)

A ray march from the camera to the depth buffer, or to the fog end, at `volumetricScale`
resolution with `volumetricSteps` steps and per-frame jitter. Density is `1.4 / fogEnd`, so
thicker fog means denser air, times a slowly drifting 3D noise (dust). Transmittance follows the
authored fog ramp. It scatters:

- the flashlight beam (Henyey-Greenstein g 0.35, through its shadow map, so bars cut the beam);
- lamp halos and shafts (g 0.25); the cube-shadowed lamps cast shafts;
- moonlight shafts through windows and trees (g 0.55): the dominant non-rim Directional Light
  whose region holds the camera, through the moonlight shadow map.

### Post stack and horror grade (`post.ts`)

- **GTAO** (three.js `GTAONode`, depth-reconstructed normals) multiplied at 85 %.
- **TRAA** (High / Ultra) or **FXAA** (Low / Medium). The scene pass has no MSAA because every
  depth consumer needs a single-sample depth texture.
- The **viewmodel** (first-person arms, weapon) is its own MSAA pass, composited by an MRT
  coverage target, so it gets the bloom and grade too. `renderViewmodel()` steps aside in
  Enhanced.
- **Bloom** (strength 0.55, threshold 0.85 HDR) on lamps, fire, arcs and the flashlight's hot spot.
- **Depth of field** (Ultra), very subtle.
- **Lens**: chromatic aberration growing towards the edges (0.0025). During insanity (the screen
  effects' blur, vignette or flash) the lens adds barrel distortion and more aberration and
  vignette.
- **Grade**: exposure 0.82, saturation 0.7, a cold shadow tint (0.82, 0.93, 1.12), a sickly warm
  highlight tint (1.10, 1.03, 0.80), then **AgX** filmic tone mapping, contrast 1.08 about mid
  grey, a cold black lift, a vignette, and luminance-weighted animated film grain (0.045).

Every grade value is a uniform (`__enhanced.uniforms.grade.*`), so none needs a rebuild.

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
| Volumetrics | 8 steps, ½ res | 16, ½ | 24, ½ | 40, full |
| GTAO | off | 8 samples, ½ res | 12, ½ | 16, full |
| Bloom | on | on | on | on |
| AA | FXAA | FXAA | TRAA | TRAA |
| Depth of field | | | | on |

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
on the development Mac while many other agents' headless browsers and dev servers were running.
The absolute numbers are therefore low and noisy. The relative cost between tiers is the useful
part. Each value is the frame probe's fps over 3 s, fly camera at the evidence poses, flashlight
on.

Each cell is the mean over the level's evidence poses, with the range across poses in brackets.
60 is the headless browser's frame-rate ceiling (display rate). 1a was measured in a quieter
run than 3a and 6a.

| Level (poses) | Original | Low | Medium | High | Ultra |
|---|---|---|---|---|---|
| 1a Death Row (cell row, guard corridor, gas chamber ×2, electrocution controls) | 57 (45-60) | 57 (46-60) | 59 (56-60) | 56 (43-60) | 38 (18-48) |
| 3a Yard, night (2) | 36 (35-37) | 43 (41-45) | 42 (42-43) | 34 (33-34) | 28 (25-31) |
| 6a Woods, night and rain (2) | 56 (54-59) | 57 (56-58) | 53 (53-53) | 47 (37-57) | 35 (26-44) |

Read the rows this way:

- Low and Medium cost about as much as Original. Low draws the scene at 0.75 scale, and in 3a
  Original's own scene glow pass costs more than Low's whole post stack.
- High adds TRAA, a lamp cube shadow and the 2048 moonlight map. It holds the frame rate in
  enclosed rooms and costs roughly 15-25 % outdoors.
- Ultra runs full-resolution volumetrics (40 steps) and GTAO, two lamp cube maps with all six
  faces every frame, and a 4096 moonlight map. It is the expensive tier: 18 fps at the 1a
  electrocution controls, where two strong lamps are both cube-shadowed. Auto settles one tier
  lower where that happens.

## Evidence

Frame strips at the same camera pose, each Original | Low | Medium | High | Ultra. Captured with
`?level=…&fly`, the Flashlight given, and the camera set through `__view.controls.setPose`.

The strips are not in the repository because they are made from the game's data. They are in
the session scratch directory `scratchpad/enhanced/strips/`, and `all.jpg` stacks every strip:

| Strip | Scene |
|---|---|
| `1a-cell-row.jpg` | 1a death row cell block, the corridor lamp and cell bars, flashlight on |
| `1a-guard-corridor-red-alarm.jpg` | 1a guard post hall: the red alarm Lighting Effect (1 Hz; frames catch either phase), the flashlight's real shadow of the pillar |
| `1a-gas-chamber.jpg`, `1a-gas-chamber-wall.jpg` | the gas chamber window, which glows green in Original, and the tiled wall. Low caught the insanity vision that plays there. |
| `1a-electrocution-controls.jpg` | the door controls where the guard is electrocuted (static: the scripted shock is not triggered) |
| `3a-yard-night.jpg`, `3a-yard-night-2.jpg` | 3a yard at night: moonlight shafts and lamp halos (Medium and up) |
| `6a-woods.jpg`, `6a-woods-2.jpg` | 6a woods at night in the rain: the flashlight in the rain and the foliage's cut-out shadows |

How they were made: a dev server and headless Brave, `?level=<lvl>&fly` (Original) and
`&gfx=enhanced&tier=low` (Enhanced, tiers switched live with `__enhanced.setTier`), the
Flashlight item given, the pose set with `__view.controls.setPose`, and four seconds of settling
before each frame. The 1a electrocution shot shows the location only; it does not trigger the
scripted shock.

What the strips show:

- Enhanced is darker and colder overall. Lamps read warm and sickly, and the flashlight dominates
  as a light with real shadows (bars, pillars) and wet specular floors.
- The authored lamp positions, the red alarm and the fog colour all survive.
- Colours bright enough to saturate lose their hue under AgX. The gas chamber's green glass turns
  near white. A per-material emissive tint is a candidate refinement.
- 3a at night is much darker than Original away from the lamps. The moonlight shafts are the
  only fill there.

## Extension points

- **Material maps** (texture enhancement): `SurfaceMaterialOptions.enhancedMaps =
  { normal?, roughness?, specular?, normalScale? }` (`engine-light.ts EnhancedMaps`). They are
  sampled with the base layer's own coordinates and become part of the shared graph's structure
  (`em:nrs` token), so every surface with the same maps layout shares one shader. Normal maps are
  tangent space, applied with a cotangent frame from screen derivatives because the engine's
  meshes carry no tangents. Confirm the green channel convention against the first generated
  maps: the textures keep the engine's stored row order (`flipY = false`). Roughness and specular
  read the red channel. Per-material scalars that need no rebuild:
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
- **Debug / QA**: `__enhanced` (tier, setTier, features, governor, probe, shadows.stats,
  uniforms) and `__enhanced.pipeline.debugView = 'scene' | 'hdr' | 'ao' | 'volumetric' | 'vm'`
  followed by `pipeline.build(__enhanced.features)`.

## Licences

All Enhanced content is generated in code: the lens cookie, the dust noise (MaterialX Perlin from
three.js), the grain (interleaved-gradient noise) and the grade. The Enhanced mode downloads no
third-party assets (HDRIs, LUTs or noise textures) and stores none in the repository. It uses
three.js r186 (MIT), including its TSL display nodes `GTAONode`, `BloomNode`, `TRAANode`,
`FXAANode` and `DepthOfFieldNode`. Nothing derived from the game data is written anywhere.

## Limits and next steps

- Screen-space reflections (`TierFeatures.ssr`) are not wired yet. Wet-floor specular carries the
  look for now. The `SSRNode` needs a roughness/metalness MRT output, which the texture work's
  maps would feed.
- Precompile: in Enhanced, the scene pass draws into the pipeline's own target, so pipelines for
  zones first seen during play compile on first sight. Registering the scene pass target in
  `warmTargets` (with its MRT) is the next step.
- The lamp-occlusion estimate subtracts the engine formula's share from baked light, so a lamp
  whose light was already baked dark can darken more than the original did. In practice the
  shadows are crisper and darker, which suits the grade.
- The red-alarm Lighting Effect, flicker and switching come through the engine rig, so Enhanced
  follows them frame by frame. An alarm shot can catch either phase of its 1 Hz wave.
