# Renderer: light selection, screen effects, shadows (SUFFERING.EXE)

This file covers what the PC renderer does on the CPU around the vertex-shader lighting of
docs/game-logic.md §19: which lights an object gets, the screen blur and the glow pass, the
present-time effects, and the character shadows. It also checks the shader library. It was
read from `SUFFERING.EXE` (image base 0x400000, Direct3D 9) and `Suffering.rfl` (base
0x10000000). Addresses are VAs.

Tags:
- **[verified]**: read in the code.
- **[strong]**: read, but a caller or the meaning of a field is inferred.
- **[inferred]**: a reading that fits.
- **[port]**: the port's choice, with no counterpart in the original.

Code:
- `src/formats/render-data.ts`: constants and pure helpers;
- `tests/re-renderer.test.ts`: tests, including a walk over all 989 programs of
  `xvsh/ShaderLibrary.bin`;
- users: `src/app/engine-light.ts` (light selection, spots, ambient boxes, projected shadows),
  `src/game/insanity/effects.ts` and `screen.ts` (screen blur and faders), and
  `src/game/fx/rim.ts` (rim light choice).

## 1. Per-object lights

### 1.1 The light classes [verified]

Every light is an object with a type at vtable +0x28 and a flag word at +0xc:

| Type | Class | vtable |
|---|---|---|
| 1 | Ambient | 0x595708 |
| 2 | Directional | 0x595780 |
| 3 | Point | 0x5953b0 |
| 4 | Spot | 0x595690 |

The colour is at +0x10. It is the bytes / 255, negated when p1 is set (0x4c5fd0).

Flag bits:
- 0x400: p9 = 1 for a point light. For an Ambient or Directional Light it means p8 is set
  ("exclusive", §1.4). Setters 0x4c9650 and 0x4c9800.
- 0x800: p9 = 2 for a point light. For a Directional Light it marks a rim light. Setter
  0x4c9830, called by the Directional Light loader 0x4c6fa0 on the extra light it creates from
  the Rim Light template.
- 0x200: set from p2, and from p7 > 0 for point lights (vtable +0x68, 0x4c2850).
- 0x100: "priority" in the sort (§1.3), skipped as a dynamic object's shadow light (§4.2). Only
  the Flashlight class sets it, on its Spot Light (§4.2).

### 1.2 Cull radius: "Light Radius Cutoff Factor" [verified]

The engine-property slot with this name (index 0x34, name stored at 0x413aa6) is never read.
The real cutoff is the float at 0x5ba608 in initialised data. Its value is 0.1, and it is read
only by 0x4c7c00, 0x4c7c3f and 0x4c8681.

When a point light is placed or changed (vtable +0x2c, 0x4c8650 and 0x4c7c20), it gets a cull
radius at +0x58:

    R' = sqrt( (0.33 r + 0.45 g + 0.22 b) / 0.1 × I ),   I = p8 × 2048²  (light +0x54)

At distance R', the light's level I/d² × luma falls to the cutoff.

**I is p8 × 2048², not (p8 × 2048)² [verified code + data].** The Point Light init (0x4c60b0)
loads p8 and multiplies it once by 2048² (`fmul [0x595460]`); the Lighting Effect animator
(0x4c55d8) and the save loader (0x4c65c0) store the same unit, and the upload (0x4d0605) passes
I × scale² to the shader. Positions are engine units (× 2048), so in metres the shader level
min(I / d², 2) is **p8 / d²** and the cull radius is sqrt(10 × luma × p8) m: the 1a cell lamp
(0xdaac67, p8 4.05) gives level 1 at 2 m and stops at 5.2 m. The port had read p8 as a radius
and squared it, 4× too strong at 2 m for that lamp and 160× for the 12.8 corridor lights.
The .ldu bake confirms it: over the vertices of 1a and 1b that the static lights should light
to 0.6–1.5 light units, bake / prediction has a median of 1.01 (1a) and 1.03 (1b) with p8 / d²,
and 0.04 / 0.03 with p8² / d² (`tests/static-light.test.ts`). A black or negative light gets 0 or NaN, so it is never selected. No retail Point
Light sets p1. The light then registers itself in the spatial structure (0x5ca5b0) with its
bounding sphere of radius R' (vtable +0x44, 0x4c8720). Every object whose bounds touch that
sphere gets the light (0x4c8ea0).

### 1.3 The object's light set [verified]

Each object has a light set (object +0xc0 or +0x54):
- 12 slots at +0x16;
- 2 ambient slots at +0x46.

Insertion (0x4c2f30) ranks lights by vtable +0x40:
- point lights, 0x4c7ed0: (0.212 r + 0.701 g + 0.087 b) × I / d² inside R', else 0;
- spot lights, 0x4c7f50 and 0x4c8a00: a cone test times the same luma.

The insertion walk:
- A directional light goes before the first non-directional entry, or before the first weaker
  directional entry.
- A light with flag 0x100 goes before the first non-directional entry.
- Any other light goes before the first entry with lower influence.
- A full set drops its last entry.

The shader upload (0x4cff10) walks the set and takes at most 8 lights. At most 5 of them may be
point lights: the counter at [esp+0x58] skips the rest. (Port: see §1.7.) The entry types it
writes are:
- 0: directional;
- 1: point;
- 2: spot;
- 3: point, above only (flag 0x400);
- 4: point, below only (flag 0x800).

The upload also has an approximation path, selected by a caller flag. It turns a point light
into a directional entry weighted by 1 − d²/R'² and skips the light below 0.1. This is the
"Approximate Point Lights" property, default 1. The scene-graph caller 0x4cade0 passes 0, so
level geometry never uses the path. Its other callers were not traced.

### 1.4 Ambient and directional regions [verified rule, strong region]

The object-side gather (0x4ca730) queries the light manager (0x5ca5b0, 0x4b8ab0) with the
object's bounds (or ±1 around its position when 0x4d4e50 fails at 0x4ca7e6; the test was not
traced) and sorts the lights it finds:
- ambient (type 1) lights into one list;
- directional (type 2) lights into another;
- point and spot lights straight into the set.

Both lists are qsorted with 0x4c9bc0, which compares the volumes (0x4d51b0) of the lights'
sector-tree nodes: the smallest region comes first.

**The region of a light is its parent node in the sector tree** (`visgraph.ts lightRegions`):
the light is registered with that node, and the query returns the lights whose node box overlaps
the object. A light under the root node ("Node 0, 0") applies everywhere. Instance scale plays no
part: 1a's root ambient 0x7f89 is scaled 5 × and the "Outdoor East" one 0x88f1 is unscaled. Every
retail level has exactly one Ambient Light and one Directional Light (with a rim template) under
the root group; the others sit under editor groups ("Backstage", "Outdoor East"), mostly as an
Ambient / Directional pair. 8b has the most: seven Directional Lights, 14 rig lights with their
rims.

**Ambient.** The list is cut after its first entry with flag 0x400 (p8, Ambient vtable +0x70 =
0x4c9650). The colours of the entries up to the cut are summed into the object ambient (c[80]);
they are averaged in one case: object flag +0xc bit 13 is set and there is no zone relation
[inferred meaning]. All 29 retail Ambient Lights have p8 = 1, so **the smallest region
overlapping the object wins**, and the root group's light is the level's ambient elsewhere.

**Directional** (cut 0x4cac44, apply 0x4cad56) [verified]:
- the gather drops rim lights (flag 0x800) unless the object is dynamic (object +0x10 bit 1)
  (0x4cab22);
- after the first entry with flag 0x400, every later entry is removed except rim lights of a
  dynamic object;
- when applying, only the first rim light is used.

The base light of a Directional Light gets 0x400 from p8 (vtable +0x70 = 0x4c9800, called at
0x4c75f8). The rim light it creates gets 0x800 (+0x74 = 0x4c9830, 0x4c7573) and, from the
template's p2, 0x200 (+0x68), but never 0x400, so a rim never cuts the list. Every retail base
light has p8 = 1 except 1a 0x8add, 1c's switched one and level 10's root one. A black base light
still cuts: 1a's root light 0x7f8a has colour 0, so in a group that holds its own pair, only that
group's base light and rim apply.

In 1a, the lights that exist (the 0x8 group lights in the showers and offices are never created):

| Group | Volume (m³) | Ambient | Directional (base colour, rim template) |
|---|---|---|---|
| root "Node 0, 0" | 3.5e6 | 0x7f89, 0x1C1E20 | 0x7f8a, 0, 7:869 (dim teal 0x1F2B2C) |
| "Outdoor East" | 6.7e4 | 0x88f1, 0x393542 | 0x88f2, 0x4E3F45, 7:901 (0xCA8960) |
| "Backstage" | 1.1e5 | 0x88f8, 0x1D202E | 0x88f9, 0x8B5236, 7:869 |
| "2nd Floor East" | 1.4e4 | | 0x8add, 0xBB8A59, p8 = 0, off at start |

The .ldu bake's flat fill in the cell block (median 12.8 / 255) is half of 0x7f89's colour, which
fits the root ambient being the one there.

Port (`render-data.ts applicableRegions` / `applicableDirectionals`, `engine-light.ts`,
`fx/rim.ts`, `world/lights.ts`, `static-light.ts`):
- the loader resolves each Ambient / Directional Light's region (`LevelData.lightRegions`);
  levels without a sector tree keep the old rule (unscaled ambient global, scaled ones boxes,
  directional lights in the smallest zone box holding them);
- ambient regions are uploaded smallest first with their p8; the shader sums the matches up to the
  first exclusive one, then the global ambient if none was;
- directional lights are uploaded smallest region first with flags (lo.w exclusive, hi.w rim,
  A.w baked); the shader loop applies non-rim lights until the first exclusive one and only the
  first rim; baked materials take only flag-2 lights;
- every rim source is its own camera-relative rig light in its Directional Light's region;
- characters (light-set objects) get the same choice made on their bounds (`objectLightSet`),
  which also counts the applied directional lights against the 8-light budget.

### 1.5 Baked + directional shader variants [verified]

`ShaderLibrary.bin` layout:
- `u32 n` (989);
- n × `{u32 key, u32 stream}`;
- n × `{u32 size, vs_1_1 tokens}`.

`CachedVSHandles.bin` starts with a float (1.1) and then holds 996 more pairs of the same kind.

Key bit 0 means baked colours (`mul r2, v10, c51.wwwx`): it matches the code of all 989
programs. Bit 1 means uniform ambient (c80). Bits 2–3 count the directional lights [strong].

The programs fall into four groups:
- 101 combine baked colours with 1 or 2 directional lights (xvsLightDir);
- 285 are baked only;
- 586 are ambient plus directional;
- 17 are ambient only.

So the comment in xvsLightDir.vsh ("only for objects without precomputed lighting") does not
hold.

**Which objects get them [verified].** The object gather 0x4ca730 takes a last argument that
0x4cade0 sets for objects whose +0x6c names a type-9 resource: the per-object vertex-colour
resource the draw code (0x498753) binds as the precomputed stream. With that argument set, only
lights with flag 2 (and enabled, light vtable +0x38) are taken. Flag 2 is set by the light
objects' init code when the light is **switchable**:

| Init | Switchable when |
|---|---|
| Point Light 0x4c6ca0 | links, p3 Lighting Effect, p6 = 0, or p6 with p2 / p4 / p5 set, or p7 > 0 |
| Ambient Light 0x4c6fa0 | links, p3, p6 = 0, or p6 with p2 / p4 / p5 set |
| Directional Light 0x4c7230 | links, p3, p6 = 0, or p6 with p2 / p4 / p5 set |

Otherwise the init clears flag 2, forgets the light and returns -5. The light stays in the
light manager for dynamic objects, but baked objects no longer receive it. A Directional Light
with a Rim Light template (p9) keeps its own light either way. That light's colour is p0
(negated by p1), and its direction is the object's local +Z axis (constructor 0x4c9890). The
light has flag 2 only when switchable. The rim light it creates (template colour p0, flag
0x800) has flag 2 cleared, so baked objects never get rim light.

The baked + directional variants therefore serve baked objects under a **switched
Directional Light**. These are p6 = 0 (off at start) with on / off inputs p4 / p5:
- 1a 0x8add (colour 0xbb8c59);
- 10 0x13d5;
- seven lights in level 2, driven by relays 0x106d / 0x106e. These carry instance flag 0x8,
  so they are never created (campaign/difficulty.ts).

Static rim-template lights (most retail ones, p6 = 1 with no inputs) light only dynamic
objects (characters, props without colours) in their region.

Port (`engine-light.ts`, `fx/rim.ts`, `render-data.ts directionalRole`):
- every Directional Light that keeps a light gets a rig directional: colour p0, local +Z,
  on = p6, p4 / p5 switch it, exclusive = p8, region = its parent group (§1.4);
- dynamic materials apply the directional lights by the rule of §1.4;
- baked materials (xvsLightPrecomputed) add only those with flag 2;
- the rim colour is the Rim Light template's p0 (it was the Directional Light's).

**Point lights** follow the same rule; see §1.6.

### 1.6 Static point lights and precomputed colours [verified code, data]

The question was where the 810 static Point Lights of retail (on at start, no inputs) reach
geometry with precomputed colours, since the run-time gather skips them for such objects.

**The type-9 resource is the .ldu entry.** The data cache at 0x5ca170 is built for resource
type 9 (constructor 0x401230, 1 MB) and its objects (vtable 0x5921d8) declare file entry type
0x52, the .ldu colour record, with their loader at 0x487610. So an object's +0x6c names its
.ldu colours. The same class is also created empty at run time (0x4cb1f0, 0x4c18c0); those
buffers carry flag 4 at +0xe.

**The engine has a CPU lighting pass, but not for .ldu geometry.** 0x4c0a40 runs the shader's
equation on the CPU over an object's uploaded light list: start from the ambient, add each
point light as colour × min(I / d², 2) × N·L̂ while d is inside the cull radius (0x4c0900; the
hemisphere modes are not tested), spots through 0x4c0680, then 0x4c0480 clamps each channel to
0..1 and packs it ×255 into a D3DCOLOR (no halving). Two callers fill a run-time colour buffer
with it:
- 0x4ca3a0, whose only caller is 0x4ca6c0 (scene object vtable +0x84). That slot is reached
  only from the draw functions, so the pass runs at the object's first draw (§1.9). It runs when
  the object has no colour resource yet, or when the object is still marked dirty (+8 bit
  0x1000) at that point. It creates the buffer (vtable +0x14c), fetches positions and normals,
  and writes one colour per vertex (alpha = opacity × the object's +0xd0). [verified]
- 0x4c1900, for a floor layer whose .ldu colours are absent or were made at run time: a
  (w + 1) × (h + 1) grid, lit from the layer's own light set; with no ambient it starts from
  white and logs "Layer: No ambient light - most likely missing from ROOT NODE!".

An object whose .ldu colours are loaded (state 3, no flag 4) skips both: its colours are used
as read.

**The bake holds the static lights [data].** Measured over every lit vertex of 1a (about 155,000
samples), summing each light class's run-time contribution:

| Light sum (light units) | Only static lights: bake median / p90 | Only switchable lights: bake median / p90 |
|---|---|---|
| 0 | 12.8 / 13.8 | 12.8 / 13.8 |
| 0.2–0.5 | 14.8 / 25.3 | 12.8 / 13.8 |
| 1–2 | 23.7 / 89.4 | 12.8 / 13.8 |
| 2–4 | 86.0 / 147.6 | 12.8 / 13.8 |

(bytes / 255 of the colour luma). Vertices lit only by switchable lights keep the flat ambient
fill however strong the light; vertices near static lights get brighter with them. 1b and 2
show the same split (1b: switchable-only medians 10.0 throughout, static-only up to 71.5).
With I = p8 (§1.2) the bake equals the run-time formula for the same lights (the earlier
reading, I = p8², made it look 20× dimmer). Its ambient follows the shader
convention: 1b's global Ambient Light is 0x131313 and its unlit vertices hold 10/255, half of
it, so that xvsLightPrecomputed's 2 × colour gives the ambient back. The colour words of the
lights agree: 741 of the 770 static Point Lights store 0xff in the colour's top byte, 682 of
the 704 switchable ones store 0.

The earlier finding that "Point Lights are not in the bake" (game-logic.md §19.1) tested lights
that were on at start without telling switchable from static; in 1a, 180 of the 254 created
Point Lights are switchable, including the cell-block lamps.

**So, in the EXE:** static Point Lights reach .ldu geometry only through the editor's bake;
switchable ones per frame through the shader; geometry without .ldu colours through the CPU
pass at its first draw (the lights that are on then and whose group holds it, §1.9) and
afterwards like .ldu geometry; dynamic objects through the shader, all lights.

Port:
- `render-data.ts pointLightSwitchable` is the 0x4c6ca0 rule; `world/lights.ts` marks each
  Point Light, and the rig (`engine-light.ts`) uploads the switchable ones (and effect lights)
  first: precomputed materials loop over those only (`u.bakedPoints`), dynamic ones over all.
  The per-vertex loop of the level's materials gets shorter (13–26 of 32 lights in the test
  views).
- `formats/static-light.ts` does the CPU pass once at load for placed models and floor layers
  without .ldu colours (`level.ts`, `extras.staticLighting`, built in `loader.ts`) and for the
  placed objects the world builds itself (`world/dynamic.ts`, `LevelData.loadLighting`): the
  object's ambient, the directional base lights of its region and the 5 strongest point lights
  at its bounding sphere, in the groups that hold it; only static ones (switchable lights reach
  it per frame) [port, §1.9]; every static light on at load, whether the object is shown at
  start or not (its first draw comes after every light exists, §1.9); the sum is
  stored clamped, not halved, and the object is then drawn as precomputed (2 × colour +
  switchable lights per frame, no rim). See §1.9.
- Spawned models (broken remains, debris, gibs, effect models) take the same pass at the spawn
  since 8340318, as the engine runs it at their first draw (§1.11). The Instance Rendered Object
  scatter and the morphing drips are still lit as dynamic objects (ambient + every light, per
  frame) [port].
- `?lighting=legacy` keeps the old behaviour throughout.

Measured (headless, 1280×720, 40 renders per view): frame cost unchanged within noise (1a
4.7–5.6 ms, 1b 2.7–3.9, 4b 0.9–5.8, 6a 0.9–10.3 ms, before and after); screenshots of the 1a
cell block, 1b and 6a are unchanged where switchable lamps light the room, and show the bake's
own colour where a static light does (the blue fill of the 1a corridor, the red glow in 1b).

### 1.7 Port: how many point lights a vertex gets

The port evaluates the equation per vertex against one uniform list of up to 32 point lights
near the camera. Summing every light within reach per vertex instead of the object's 5 clipped
the 400/255 clamp in lamp-lit rooms: in the 1a cell block (two warm lamps per cell, 0xdaac67,
radius 1.8 / 4.05, cull radius up to 10.5 m) a wall vertex got 8 or more lamps, every channel
clipped, the light turned white and the walls showed their green-grey texture instead of the
olive of the PC captures; characters (static lights too) turned pale and flat.

- **Characters** (`engineLightMaterial(…, { lightSet: true })`, `src/app/character.ts`) get the
  engine's per-object set: `EngineLightRig.objectLightSet` ranks this frame's point lights at
  the mesh's bounding-sphere centre with `pointLightInfluence` (cull radius + object radius,
  0x4c8ea0), keeps min(5, 8 − directional − spot lights applying) and hands the slots to the
  shader as per-object uniforms (`onObjectUpdate`); the object's ambient is the smallest
  Ambient Light box holding the centre (§1.4) instead of a per-vertex box test. The chosen
  lights have no per-vertex cut-off, like the engine's.
- **Merged geometry** (the level is one mesh per material; props without colours) keeps the 5
  strongest lights at each vertex (an insertion sort in the vertex shader) [port approximation
  of the per-object choice].

Measured on the 1a opening ("Goose", cues of the dialog log at 106.8, 123.5 and 138.2 s),
picture area between the bars, against three captures of the PC version at the same moments:

| | capture | before (flashlight on, ≤ 32 lights) | after |
|---|---|---|---|
| mean luma | 58 / 56 / 48 | 93 / 71 / 81 | 54 / 59 / 64 |
| luma σ | 36 / 35 / 39 | 31 / 28 / 34 | 34 / 27 / 32 |
| mean RGB (cue 123.5 s) | 75, 54, 21 | 74, 72, 51 | 72, 58, 31 |

(The "before" frames are the nearest shots of the same scene, not always the same cue.)
That "after" still read p8 as a radius (I = p8²) and had no stage-1 doubling; both are fixed
in §1.2 and §1.8, which also resolve the colour difference it left (the captures redder and less
blue, their highlights at 250 where the port stopped near 200).

### 1.8 Texture stage 1 doubles every world pass [verified]

The frame function enters the world-view loop only when the world is up (`[0x5c5c30] & 2`,
0x48c4b4), and just before it sets **texture stage 1 COLOROP = D3DTOP_ADD** (0x48c4d7). The
device set-up left stage 1's COLORARG1 and COLORARG2 at D3DTA_CURRENT (0x49bc02, 0x49bc18), and
no other code sets a stage-1 colour operation until the frame end turns it back to DISABLE
(0x49d5f5, 0x49beea) before the front-buffer passes. (A census of every SetTextureStageState
call, device vtable +0x10c: the other stage-1 calls set its alpha operation and arguments.) So
each world pass leaves the texture stages as **saturate(stage 0 + stage 0)**:

- a lit pass: saturate(2 × texture × oD0) with oD0 = 0.5 × min(L, 400/255): light level 1 shows
  the texture as is, the clamp allows 1.57 ×, the output saturates (the captures' 250 highlights);
- a tinted pass (§3.5): texture × tint, the builders' halving undone;
- a white-tinted modulate-2x detail layer: texture as is, then 2 × destination × it, neutral at
  50 % grey (the usual detail-texture convention; with plain MODULATE it was neutral only for a
  white texture);
- baked colours: 2 × bake byte, so a byte of 128 is the texture as is, the overbright convention
  of the halved bake (§1.6).

This is the design behind the halvings: oD0 and TFACTOR are clamped to 0..1, so the light is
stored at half and the stage doubles it back. The previous reading (stage 0 MODULATE only) left
every surface at half brightness, which the port had hidden by squaring p8 (§1.2).

Port: `engineStages` (`engine-light.ts`, render-data.ts `WORLD_STAGE_GAIN`) doubles and
saturates each pass's gamma colour in `engineLitColor` (characters, held weapons, props),
`shadePass` (every layer of a surface material, lit or tinted) and the floor splats. Particle
billboards are doubled too [strong]: their vertex colour is the particle's colour word unhalved
(the billboard build 0x4ad888 copies particle +0x30 to the four vertices; the particle update
0x4ac4e0..0x4ac5f3 rewrites only its alpha byte, or copies the lit colour of a p46 = 3 system),
and the quad is drawn at once (0x496c60 sets the stage-0 texture, 0x4969f0 draws) from the
particle system's render, inside the world loop. Port: the Particle Fountain pools
(`world/fx.ts`, `particlePassColor`); game-logic.md §14.2.

Measured on the 1a opening ("Goose", t 120.7 / 126.7 / 141.7 s, picture area between the bars),
against the three PC captures (`cine.mjs` in the scratch tools: headless, 1280×720):

| | capture | before (I = p8², ×1) | after (I = p8, ×2) |
|---|---|---|---|
| mean luma | 58 / 56 / 48 | 54 / 59 / 64 | 52 / 74 / 53 |
| luma σ | 36 / 35 / 39 | 34 / 27 / 32 | 33 / 50 / 57 |
| lit wall RGB (120.7 / 126.7) | 122, 98, 34 / 95, 76, 29 | 96, 94, 40 / 78, 68, 35 | 89, 77, 35 / 103, 84, 56 |
| shirt RGB (126.7 / 141.7) | 128, 55, 20 / 141, 67, 25 | 91, 47, 8 / 140, 90, 26 | 119, 54, 11 / 235, 131, 33 |
| cell bars, 95th pct (126.7) | 179–194, 143–155, 85–93 | 96, 85, 61 | 237, 184, 152 |
| mean RGB (141.7) | 68, 45, 17 | 76, 63, 33 | 72, 51, 23 |

The lit walls now carry the lamps' warm colour (R / G 1.16–1.23 against the captures' 1.25; it
was 1.02–1.15) instead of the texture's grey-green under clipped white light, and highlights
reach 250. The blues stay higher than the captures' (their darkest 10 % hold blue ≤ 3 where the
port has 4–13, a crush of the video).

The characters and cell bars then came out too bright (and the bars blue). The cause was not the
doubling, which applies to every world pass, characters included (no shader program skips the
halving footer for a lit character), but the regions of §1.4. The port had used the "Outdoor
East" ambient as the global one, applied the Outdoor East and Backstage base lights everywhere
(they lie in no zone box), and lit characters with Outdoor East's bright rim (the nearest).
With the parent-group regions, the same frames (port region means; the 126.7 s pose differs from
the capture's, so its regions sample other parts of the body):

| | capture | before regions | with regions |
|---|---|---|---|
| mean luma (120.7 / 126.7 / 141.7) | 47 / 46 / 38 | 52 / 74 / 54 | 48 / 53 / 37 |
| face RGB (120.7) | 78, 46, 18 | 178, 115, 76 | 80, 55, 31 |
| shirt RGB (120.7) | 109, 50, 17 | 157, 77, 8 | 95, 50, 4 |
| face RGB (141.7) | 158, 108, 52 | 209, 157, 100 | 105, 77, 47 |
| shirt RGB (141.7) | 141, 67, 25 | 235, 131, 33 | 103, 59, 14 |
| cell bars, 95th pct (126.7) | ~198, 160, 97 | 255, 220, 182 | 143, 132, 101 |

The characters now sit at the captures' level against their surroundings (face / wall 0.9 and
3.75 against 0.64 and 3.5). Remaining: the 141.7 s face and the cell bars are darker than in the
captures and the bars lack their warm colour; with the ambient and directional lights settled,
what lights them is the point lights (which reach the bars, and how strongly): §1.9.

### 1.9 Point lights on the 1a cell block; objects without .ldu colours

Traced for the "Goose" cinematic, where the cell lamps light walls, inmates and cell doors.

**The point-light path is as ported [verified].** The constant upload (0x4366f1..0x4369a5)
writes, per point light entry, c[8 + 2i] = position and I (entry +0x38, read through 0x4c07f0)
and c[9 + 2i] = colour and the hemisphere sign (−1 for flag 0x400 = p9 1, +1 for 0x800 = p9 2,
0 otherwise); c[51] = (1, 0.5, 0, 2) and c[82] = 400/255 are set at 0x435490; the ambient c[80]
is the packed object ambient / 255. With 0x4c5fd0 (colour = bytes / 255), 0x4c60b0
(I = p8 × 2048²) and the object-space conversion of 0x4cff10 (the light position goes through
0x4d8060, whose +0x40..+0x48 hold 1 / scale, and I is multiplied by that squared), the level is
min(p8 / d², 2) in metres for any instance scale. The 5-point cap (0x4d05c1) holds;
`ShaderLibrary.bin` nevertheless has 158 programs with 6 to 8 point lights, so it is not a record
of what the engine asks for.

**The cell lamps are switchable** (0xdaac67, p8 4.05, On / Off inputs and a Light Housing link)
and are in no .ldu colours (the cell block's bake is the flat fill). Nothing near the cells is a
static light, no Lighting Effect drives the lamps, and the cinematic changes no light before
145.8 s ("Stage Lights Off"), so the three compared frames see the lights of the level start.
Neither double counting nor under-counting on baked walls: over the 13,611 vertices of 1a's
baked objects around the cells, the red light of the port's per-vertex 5 strongest lights and of
the engine's per-object 5 (ranked at each object's centre, no per-vertex cut) average 0.235 and
0.234; all lights in reach would give 0.367.

**Objects without .ldu colours: when the load-time pass runs, and which lights it sees.**

What the code does [verified, SUFFERING.EXE]:
- The pass 0x4ca3a0 has one caller, 0x4ca6c0, the scene object vtable +0x84 (vtable 0x590a08 is
  the only one holding it). On scene objects that slot is called only by the draw functions
  0x4930f0 (0x493525) and 0x492950 (0x492969). They call it after the frame's gather (+0x164 =
  0x4cade0, from the traversal at 0x49612c / 0x496651 and the render list at 0x4a16fc), and only
  when the upload holds at least one light. A non-zero return (no colours yet) skips the draw
  for that frame. 0x42c6f7, given earlier as the caller, calls +0x98 (0x459150, a matrix
  getter) and has nothing to do with lighting. The pass therefore runs at the object's first
  draw, not when it is created or loaded.
- The light set is created lazily by the first gather (0x457810, which marks it dirty, +8 bit
  0x1000). So the first draw always does a full gather (0x4ca730), the one 0x4ca6c0 repeats
  just before the pass. That gather:
  - takes every light the light manager returns for the object's box;
  - point and spot lights must be on (light +0xc bit 0). Turning a light off removes it from
    every light set (0x4c8320 → 0x4c8210 → 0x4c7d00), and its colour is zeroed until it is
    turned on again;
  - ambient and directional lights are taken by region (§1.4). For an object without colours
    they need no on bit;
  - keeps a light of any type only if the light's group holds the object. A light is
    registered under the nearest named group above it (0x4c91b0 → 0x4b5930 → 0x4b6570). Node
    flag 2 marks a group: the sector tree reader 0x4b9af0 sets it on kind-1 records. 0x4b5aa0
    then walks up from the object's node and compares each node with that group. An object
    flagged +8 bit 18 or +0xc bit 13 skips the test, and no placed prop sets either;
  - feeds an upload (0x4cff10) of at most 8 entries, 5 of them point lights, ranked as in §1.3.
    The pass runs 0x4c0a40 over that upload: from the upload's ambient, directional (0), point
    (1, 3, 4: 0x4c0900, cut at the cull radius, no hemisphere) and spot (2) entries. 0x4c0480
    clamps each channel to 0..1 and packs it without halving. In vertex-shader mode
    (0x100000 at the device wrapper +0x64, set by 0x49b670) the upload converts lights into
    object space, matching the model-space vertices the pass reads.
- Afterwards 0x4cade0 finds +0x6c naming a loaded type-9 resource. The object is then
  precomputed (only flag-2 lights, no rim), and its dirty bit is cleared in each frame's
  gather, before the draw, so the pass never runs again. Switching a light afterwards only
  inserts it into the light sets in its box (0x4c8ea0 → 0x4c2f30, on registration) or removes
  it (0x4c7d00), which reaches the object per frame and only if switchable. An Ambient or
  Directional Light's registration marks the objects in its region dirty, which only causes a
  new gather.
- Only two Suffering.rfl paths force a pass themselves: the Sky / Sun relight 0x1012a5a0
  (forces dirty, +0x164, then +0x84) and the Instance Rendered Object model copy 0x100ba060.
  Switches and pickups have none (Switch vtable 0x10159e28 scanned).

So such an object shows 2 × (ambient + the lights of its first draw, in its groups), clamped per
channel, plus its switchable lights per frame.

**Objects shown at start see every light too [verified code; port rule since the user report
of docs/playthrough.md row 69].** By that code an object is first drawn with every light of the
level present, shown at start or not: nothing draws the world while the level loads (0x48c160
only draws the loading screen, the WM_PAINT render 0x437c6f is off while a frame runs
(0x5dc0d0), RedrawWindow 0x437f60 is called once when the window is created), and the lights
register in their own init, at creation. The port nevertheless kept, from 12639a0 to this fix,
only the lights stored before a start-visible object (its level index), because of one
comparison with a PC capture of the 1a cell door 0x587a at 126.7 s of "Goose":
- the capture: bars p95 180, 143, 86, p50 62, 45, 19, shadow sides p10 27, 18, 4;
- every light, as the port baked it then (static and switchable, so the cell lamps counted
  three times: twice in the colours, once per frame): p95 255, 255, 197;
- the lights created before it (none): p95 99, 79, 48, half the capture in every channel.

The comparison that lost was not the code's rule as the port now applies it: since 4d9e521 no
switchable lamp goes into the colours, and "ambient and static lights in the colours, lamps per
frame" was never compared with the capture. The capture's blue shadow floor (4) is no evidence
against the ambient either: its darkest blues are crushed to 0..3 everywhere (§1.8). Applied to
every start-visible object, the creation-order rule drew 100 of 1a's 121 Switches (every door and
locker: the root Ambient Light is index 3206) and most pickups with black colours, lit only by
their switchable lamps: pitch black in a dark room, and, where a level's ambient is stored in the
middle, one door of a pair lit and its twin black (1b doors 0x653a / 0x81df, lockers 0x7b58 /
0x8210). The 0x4c0480 pack was checked again: each channel clamped to 0..1 (constants 1.0 at
0x58c988, 0.0 at 0x58c2ac) and multiplied by 255 (0x58f4b8), no halving.

The port now gives every unbaked placed object (dynamic.ts, level.ts merged models, pickups
dropped during play) the lights on at load in its groups [port: on at load stands for on at the
first draw]. Measured (headless, 1280 × 720, flashlight off, luma of the object through a
magenta mask, against a 10..50 px ring around it), before → after:

| Object | Original | Enhanced Medium | ring (Original) |
|---|---|---|---|
| 1a lockers 0x6cc4 / 0x6cc6, closed | 0.0 → 25.1 | 4.2 → 22.4 | 21.9 |
| 1a lockers, open (inside faces) | 0.1 → 27.5 | 4.2 → 24.5 | 20.3 |
| 1a door 0x734b (dark corridor) | 0.0 → 28.2 | 6.8 → 23.7 | 9.2 |
| 1a door 0x5616 | 0.0 → 21.0 | 5.4 → 18.3 | 10.0 |
| 1a cell door 0x587a (lamps), mean / p95 | 32.3 / 112 → 55.8 / 149 | 25.6 → 44.8 | 20.7 |
| 1b door 0x653a (its twin 0x81df: 9.5) | 0.0 → 9.6 | 3.2 → 8.8 | 6.8 |
| 3a door 0x16a5 | 0.0 → 36.1 | 8.0 → 29.9 | 10.2 |
| 3a door 0x3328 (had the ambient by order) | 36.6 → 36.6 | 36.0 → 36.0 | 35.7 |

Unbaked objects in an ambient-only room now show 2 × the ambient against the halved bake's 1 ×
around them (§1.6), which is the code's arithmetic. Level geometry, characters and .ldu props
are unchanged (the 1a cell-row view differs only on the unbaked objects; a repeat with the same
code changes 0.0 %).

The port bakes only lights without flag 2 [port, inferred]. The code would bake a
switchable lamp that is on at the first draw, but no capture shows one in such colours. Baked
lamps also stay lit after the lamp is switched off. This was a bug at 18233af: the fallen cell
door 0x848d, hidden until the guard scene, got the cell lamps in its colours and stayed bright
across the room after the scripted lights-out (headless, 1a cell-row walk-out with the 14
Timer-0x861a housings switched off: grate p95 35, 30, 23 at HEAD, 17, 17, 17 now). The
switchable lights still light these objects per frame. The Shiv keeps the ambient in its colours
and gets its cell lamp per frame. On screen it measures about 0.75 of its 18233af brightness.
Placed models merged into the level geometry (`level.ts`) and dynamic objects
(`world/dynamic.ts loadTimeSet`) both apply the group rule (`static-light.ts sectorGroups`).
Floor layers (0x4c1900, their own gather 0x4a3780) keep every light, with no group test
[inferred].

The group rule in 1a removes a lamp from 15 of the 182 unbaked dynamic objects (1b: 16 of 262),
for example the Breakable 0x7b16 in cell 5. The port applies it to the load-time pass only; per
frame, `engine-light.ts` still lights by distance.

The port lit these objects as dynamic objects (ambient + the camera-relative teal rim of 1a's
root group + every light per vertex), which made the cell bars grey-silver.

Measured (headless 1280×720, `cine.mjs`, picture area between the bars):

| | capture | before | after |
|---|---|---|---|
| cell bars, 95th pct (126.7 s) | 198, 160, 97 | 143, 132, 101 | 98, 79, 47 |
| cell bars, mean (126.7 s) | 127, 99, 56 | 93, 83, 63 | 64, 50, 30 |
| lit wall (120.7 / 126.7 s) | 122, 98, 34 / 95, 76, 29 | 89, 77, 35 / 77, 69, 41 | unchanged |
| face (120.7 / 141.7 s) | 78, 46, 18 / 158, 108, 52 | 84, 57, 32 / 109, 79, 46 | unchanged |
| shirt (120.7 / 141.7 s) | 109, 50, 17 / 141, 67, 25 | 93, 49, 5 / 104, 60, 14 | unchanged |

(The 126.7 s wall box crosses a door bar; the 141.7 s figures move by a few levels between runs
with the pose.) 1a gameplay start: 4.6 % of pixels change (the other cell doors); 6a start: 0.8 %.

**The run-time colours are drawn like .ldu colours [verified].** The scene object draw
(0x4986f0) takes the colour stream of the +0x6c resource (0x4873c0) and calls the shader set-up
0x436af0 with mode 1 (precomputed) and the object's upload. The key gets bit 0 (precomputed) and
the light counts (directional bits 2–5, point 6–9, hemisphere 10–13, spot 14–17); the program is
xvsLightPrecomputed (r2 = 2 × v10) plus the point lights (r2 += colour × min(I / d², 2) × N·L),
then the footer (min 400/255, × 0.5 into oD0), then stage 0 MODULATE and stage 1 ADD. c[51],
c[80] (the packed ambient × 255, unhalved: 0x4363c0) and c[82] are as in §1.5 / §1.8. Nothing on
this path halves or doubles differently from .ldu geometry, and the port draws these objects
through the same precomputed material. Two details of 0x436af0: a non-precomputed draw whose
upload holds no light at all is drawn with xvsLightUniform at c[80] = 0x7f7f7f (the texture as
is; does not arise in retail levels, whose root Directional Light is always in the upload), and a
precomputed draw sets c[80] to white (only its alpha is used).

The fixed-function path (`Use Vertex-shader renderer` off, engine property 0x44, flag 0x100000
at the device wrapper +0x64, 0x49b670) lights through Direct3D lights (0x49bc40): diffuse = colour
× 0.5, ambient bytes halved, Attenuation2 = 1 / I, Range = 8 × cull radius; after the stage-1
doubling that is the same level without the clamp at 2, so it is no source of a factor 2 either.

The gather at 0x4a3780 (light set +0x54, colour resource +0x60, drawn by 0x4994f0 / 0x499c20) is
the floor layers' (class 0x594164: a height grid, 0x4c0bc0), not the characters'. Characters are
scene objects like the props: gather 0x4ca730, upload 0x4cff10, draw 0x4986f0, as ported.

**Open: point light is about half as strong as in the captures.** Everything the lamps light is
darker than the captures by a similar factor: the doors by 2.0 in every channel, the inmates by
1.5 to 2 (doubling the point lights and dropping the ambient matches the 141.7 s face and shirt
within 10 %), the baked walls by 1.25 to 1.4 with less blue than the port's fill would allow.
Doubling every point light overshoots the walls (120.7 s: 170, 143, 61), so it is not one global
factor either. The code above (constants, units, colour words, cull radius, budget, stage
doubling of §1.8, the draw of run-time colours, the characters' gather and the fixed-function
path) leaves no factor 2; what remains untraced is the light manager's ambient scale (+0x34 /
+0x38, setters at light manager vtable +0x1c / +0x20, default 1: an ambient whose mean square is
below +0x38 is multiplied by +0x34 when +0x34 < 1, 0x4cb134 and 0x4a3d77; no caller found in the
EXE) and the captures' processing (their darkest blues are crushed to 0–3). The shirts' hue
(redder than the INMATE texture 10:299 can show under the lamp colour) is outside the lighting.


### 1.10 Lighting Effect: waveform-driven colour and strength [verified code, data]

The Lighting Effect class (0x6968ce68) is an engine component (vtable 0x595468; init 0x4c4c40,
update 0x4c5ba0 -> 0x4c5820, save / load 0x4c4ae0 / 0x4c59a0, message map 0x5ba480). It keeps
a clock t (+0x14), a running flag (+0x18), an "attached" flag (+0x1c) and a list of light
handles (+0x8). The update adds the frame time to t and runs four channels, one per property
group, each `(from, to, curve)`:

| Channel | Properties | Writes | Code |
|---|---|---|---|
| colour | p6 -> p7, curve p8 | Point / Spot Light colour (+0x10 current and +0x1c base), bytes / 255 | 0x4c4f20 |
| strength | p9 -> p10, curve p11 | Point Light I = value × 2048² (+0x54, the p8 unit of §1.2) | 0x4c5450 |
| spot | p12 -> p13 × 2048, curve p14 | Spot Light cone setter | 0x4c5260 |
| spot length | p15 -> p16 × 2048, curve p17 | Spot Light 0x4c8c10 | 0x4c5630 |

A channel whose curve does not resolve does nothing, so the white p6 / p7 of most templates are
unused and the light keeps its own colour. Otherwise the curve is sampled at fmod(t, duration),
k = (sample + 1) / 2, and value = from + (to − from) × k. With p1 = 0 a channel stops once
t reaches the curve's duration and the light keeps the last value written. After the channels
the update marks every Point Light dirty (vtable +0x2c: cull radius). Light Housings are not
touched: only handles whose class is Point Light (0x7dffd694) or Spot Light (0x54e01f83) are
collected or written.

- **Placed effects**: init collects the linked Point / Spot Lights; p0 sets the running flag and
  the object's update flag. Map: p2 On (0x4c49d0) and p3 Off (0x4c49f0) set / clear both (Off
  freezes the lights at their current values), p4 Destroy (0x4c4a20). p5 has no handler.
- **Attached effects**: a Point Light with p3 creates the template as an object (0x4c6d64,
  handle at light +0xe), whose init gets the light as owner: the light is its only target and
  p0 sets its update flag. The light's own update also calls 0x4c5820 for it every frame while
  the light is on (0x4c7b09; Spot Light 0x4cf69b). Nothing guards against both running, so a
  p0 = 1 template on a lit light advances twice per frame [inferred: both paths reach the update
  unguarded; not observed at run time]. On / Off of an attached effect only change +0x18.

**Curves** (.wdu type 0x60; reader 0x4881c0, sampler vtable +0x60 = 0x487d40): the first word
is the element type (0 int8, 1 int16, 2 int32, 3 float, 4 raw bytes), not a "kind"; samples =
bytes / channels / element size; duration = samples / rate (0 for type 4). Sampling at t:
x = t / duration × samples, i = trunc(x); i ≥ samples − 1 holds the last sample, i ≤ 0
returns sample 0 without interpolating, otherwise samples i and i + 1 are lerped; integers are
normalised by 127 / 32767 / 2³¹. Every Lighting Effect curve in retail is int16 or float.

**Retail data.** 46 templates. The 1a alarm template 7:176 (red Point Lights 798d, 7999, 79a2,
7fef, 8091..8093; 1c 7d4e; placed effect 8015 started by the BustedDoor STOMP) has p8 unset,
p9 0, p10 8, p11 = 7:2: a 30-sample int16 square wave at 30 / s, about +0.966 for 0.5 s then
−0.966. The red light (p0 0xee3539) is therefore pulsed between strength 7.86 and 0.14 once a
second (twice under the double update above), instead of its own p8 0.3125–4.05. 7:583 (8148)
is the same wave to 31.25. The fire lights 7:968 flicker strength 7.2–16.2 on 4:110 (1 s of
random int16 levels); the cell-block lamps 7:231 / 7:233 run 0.05–4.05 on 4:110 / 4:107 (4:107
sits near k = 0.5, i.e. about 2.1, with short flashes); the blue lamps 7:237 run 1.8–4.05 and
lerp their colour 0x728b88 -> 0x7b7d91 on 4:107. The port had read p6 / p7 as flicker colours
with a p9 period, which replaced every effect light's colour with white and left strength alone.
Port: `game/world/lights.ts`, `formats/model.ts` parseWaveform / waveformSample.

### 1.11 Port: the dynamic lighting path drew nothing in 1b, 6b and 7 [verified in the browser]

Found after 8340318 (docs/playthrough.md row 91). The gib chunks of a creature-form kill were
spawned and counted as draw calls, but frames with them shown and hidden were the same. That
commit gave spawned models the load-time pass, which hid the fault without finding it.

**Cause.** This was a TSL code-generation hazard, not a lighting value. `engineLightFactor`
passed `positionWorld` / `normalWorld` straight into the light builders. TSL emits a node's
property assignments (`positionLocal = position`, `v_positionWorld = ...`, `normalLocal`,
`VERTEX_normalWorld`) where the node is first built. In the dynamic per-vertex graph
(`dynamicBase`), that first use is inside the Loop over the Ambient Light regions. With
`u.ambBoxes` = 0 the loop body never runs. `positionLocal` keeps its zero value, the clip
position becomes `modelViewProjection × (0, 0, 0, 1)`, every vertex lands on the object's
origin, and every triangle is degenerate. So the draw call ran and drew no pixels.

The generated WGSL showed this, and the WGSL compiled without errors. The other suspects were
ruled out:
- the colour and alpha were not zero: even `vec4(1)` as the colour drew nothing;
- no uniform was left unbound;
- there was no NaN;
- the alpha test did not cause it;
- a missing colour attribute was not the cause.

**Where it applied.**
- It depends on the level, not on what changed recently. The graph has been built like this
  since b61cb37 (4 October), and three.js is the same version throughout.
- Census of Ambient Light regions per level: none in 1b, 6b and 7. Every other retail level
  has 1 to 6. In those three levels every lit surface on the dynamic path drew nothing.
- The same hazard sat in the other two graphs. In `bakedBase` (all precomputed geometry: level
  parts, .ldu props, objects lit at load) the position was first built inside the directional
  light loop. In `objectBase` (characters) it was the normal. So the level and its props would
  have vanished in any frame with no directional light uploaded, and characters would have lost
  their point lights. No retail start has 0, so it was not seen.

**Users of the dynamic path** (not precomputed, no light set; invisible in 1b / 6b / 7 before
the fix):
- `weapons/models.ts buildStaticModel`, lit:
  - thrown objects in flight (Molotov 4:249, TNT, grenades, flares; `weapons/system.ts launch`
    and the NPC throws);
  - the throwable carried on the back (`ThrowableCarry`);
  - spent casings;
  - hardpoint attachments (`weapons/attach.ts`);
  - rigid (unskinned) held models (`buildHeldModel`);
  - the Black One's objects;
  - skinned-prop stand-ins.
- `weapons/system.ts matBrass` and `player.ts`'s placeholder body.
- `world/dynamic.ts` meshes built without colours and without the load-time pass:
  - the DripMorphingModel frames (`props.ts`, 1b: 30 drips; their lit 3:2539 frames drew
    nothing, while the additive 3:2535 cards were unaffected);
  - the Instance Rendered Object scatter;
  - placed objects whose .ldu record names the model but holds no colours. The only ones in
    retail are 1b's Switches 7ea0, 7ea2..7ea5 and 81cc (0 colours for the 228 vertices of
    7:1007).
- Character surfaces built through `createSurfaceMaterial` without a light set: the effect
  passes with an untinted layer (`character.ts`).

Not affected:
- Skinned characters, guns and pickups (light set);
- precomputed and load-time-lit objects: doors, lockers, pickups, weapons dropped by NPCs (a
  dropped pickup is a placed object, `world.ts placeDrop`), breakable debris, gibs, Part Cap
  pieces and other spawned models since 8340318;
- decals (unlit basic materials).

**Fix.** `engineLightFactor` builds the light inside one `Fn` whose first statements are
`positionWorld.toVar()` and `normalWorld.toVar()`. That emits the position and normal at the top
of the vertex stage, before any loop, for all three kinds (dynamic, precomputed, light set). The
light values are unchanged where the loops ran before.
- Tests:
  - `tests/engine-lit-draw.test.ts` checks the order in the source;
  - `tools/smoke.mjs ENGINE_LIT_PROBE` renders a box with each kind into a 32² target in 1b,
    with the frame's light counts and with every loop count at 0, Original and Enhanced, and
    fails on a kind that covers no pixel. At HEAD it failed for the dynamic and surface-dynamic
    kinds (0 px) and, at 0 counts, for the precomputed ones; it passes after the fix.
- Measured in headless Brave, 1b, scenarios in scratch. Each figure is offscreen pixels of the
  object's own meshes, or the change between shown / hidden frames:
  - thrown Molotov 4:71: 0 px at HEAD, 194 px fixed, Original and Enhanced;
  - drips: 146 / 150 meshes drawing at HEAD, 150 / 150 fixed;
  - unchanged, and drawing in both modes: gib 3:2834 (33 meshes), the debris of Breakable 6aab
    (15), door 79b2, a dropped Tommy Gun pickup (4:260 → 4:1403).

**Objects without colours and the load-time pass.**
- The static draw 0x4930f0 is always an object's first draw. The object list sends an object to
  the dynamic draw 0x492b40 only once its +0x10 bit 8 is set (with setting 6 off, 0x4a15d1).
- The only writer of that bit is the static draw itself, after it has drawn (0x4937ae). It sets
  it only for an object with no skin instance and with +0xc bits 5 and 14 clear.
- So a spawned, dropped or broken-off object also meets 0x4ca6c0 (vtable +0x84, from 0x493525)
  at its first draw and gets the CPU pass. spawnModel's `lightAtLoad` is that rule, with the
  load-time light set standing for the lights on at that draw [port, as §1.9].
- The draw that follows (0x492b40) does not call +0x84 again. Which colours or lights it uses
  is not traced.
- The DripMorphingModel frames and the Instance Rendered Object scatter are still lit per frame
  as dynamic objects [port]. Their frames are built at the origin and placed by a parent, so a
  pass at load would light the wrong place. The engine forces the pass for the scatter's model
  copy itself (0x100ba060, §1.9).

## 2. Spot lights [verified]

The Spot Light instance loader (0x4cf450) calls the light factory (light manager vtable +0xc,
0x4c3830, constructor 0x4c99e0). The arguments are R = p10, S = p8 and L = p9, each × 2048.
The constructor stores:

    k = 1/(L − S);  +0x60 = R·k;  +0x64 = 1/(R·L·k);  +0x68 = R·S·k;  +0x6c/+0x70/+0x74 = R, S, L

Per draw, the upload (0x4d0191 and 0x4369c8) sets the xvsLightSpot constants:
- c10.w (start) = R·S/(L − S);
- c9.w (1/range²) = ((L − S)/(R·L))²;
- c8.w = 0.05 × (2L)² × c9.w = 0.2 (L − S)²/R².

So p8 is the start, p9 the length and p10 the cone radius. The cone widens by p10 between p8
and p9, so its slope is p10/(p9 − p8). With p8 = 0 these are exactly the formulas the port
used before, with p9 and p10 read as "radius" and "range".

For the flashlight beam 4:123 (p8 1, p9 6, p10 10), the fall-off reaches 0 at 12 m, nothing
is lit before 2 m, and I = 0.05. For the spill 4:669 (1, 4, 5), the range is 6.7 m, the start
1.7 m and I = 0.072. `render-data.ts spotConstants`; `engine-light.ts` uses it.

Runtime setters (0x4c8bd0 for the radius, 0x4c8c10 for the length) recompute the constants.
0x4c8b50 also moves the light along its axis. Lighting Effect animators drive these
(0x4c5630, which lerps p15 → p16).

### 2.1 The flashlight belongs to an item [verified]

The Flashlight action (0x426, F) finds the player's flashlight object: a handle at Player
+0x134 whose class must be Flashlight (0xcf3a3fa5; RFL 0x10049ed8 → 0x10007d50); without one
the key does nothing. The handle is set when the player receives an item of class Flashlight
(the give code 0x10038f84): the object is attached to the player and switched on (Flashlight
vtable +0x94, 0x10038fee). So 1a starts in the dark: the lamp appears with the office pickup
(Ammo Box 0x6978 → Flashlight 4:72); in later levels it travels in the inventory, and a level
started on its own finds one in its Player object's start kit (6a: Ammo Box → 4:72).

Port: `weapons/data.ts holdsFlashlight` (a Flashlight-class item in the inventory) and
`flashlightLampOn` (off without one, on when just received, else the player's choice); the
weapons system applies them every frame and sets `LevelRenderer.flashlightAvailable`, which
`toggleFlashlight` checks. The developer viewer, without the weapons system, keeps the free
lamp. The port's lamp hangs on the view camera; while another camera shows the player (a security
monitor's feed) the renderer holds it at his eye, aimed along his view (`held-lamp.ts`), since the
original's lamp is attached to him, not to the view (game-logic.md §14.5).

## 3. Screen effects

### 3.1 Screen blur [verified]

Each frame, the Screen Blur RFL class (vtable 0x10159a08, update 0x10129070) calls an engine
interface (EXE vtable 0x594940, slot +0xc). It passes the eased A × 0.01, B × 0.01 and the
mode p2, with 3 mapped to 4. The interface stores them and sets an active flag. Stopping
(slot +0x10) clears the flag. One blur state exists, so the last update of a frame wins.

When the flag is set, 0x4b0e60 calls renderer vtable +0x4c (0x49c270) with (A, B, mode) once
per frame. Nothing is drawn while paused (`[0x5c6e70] & 3`).

0x49c270 draws the previous output frame, which is the other front-buffer ping-pong target
(renderer +0x120 / +0x124), over the new frame as a full-screen quad:
- vertex colour white, alpha min(A × 1.4 × 255, 225);
- UVs from B to 1 − B (0x495750), a zoom towards the centre;
- the material blend state of `mode` (§16 of game-logic.md): 1 alpha blend, 2 additive,
  4 reverse subtract.

The result becomes the next frame's "previous" image. Everything happens on gamma-encoded
values. Retail blurs use mode 1, and mode 2 in some FX templates (FX 3194 / 3198 / 4038).

The ping-pong targets exist only while "DirectX FrontBuffer Effects" is on (0x49d7c0, global
0x5c6d08, toggled by engine property 0x3a). Which option turns it on in retail play was not
traced [inferred: the Pixel Shaders option, as in the port].

Port (`effects.ts`, `screen.ts`):
- the alpha / inset / blend mode come from `screenBlurPass`;
- the ping-pong targets hold gamma values;
- the faders are alpha-blended on gamma values too [inferred: SRCALPHA / INVSRCALPHA];
- the creature-form edge darkening stays a port addition.

### 3.2 HDR scene glow ("HDR ScreenBlur") [verified structure]

At the end of the frame, 0x49d5d0 calls 0x48d0a0 on the glow state at 0x5ba0a4. Two
conditions apply:
- engine property 0x39 "Enable HDR ScreenBlur" is set (default 1);
- the front-buffer targets exist.

The pass works on three 256² targets (0x48cce0). It runs four levels, at 256, 128, 64 and
32 pixels. At each level:
1. Down-sample the previous level, or the frame for level 0, at vertex colour 0x80 (× 0.5).
   An alpha test with ref 5 (GREATER) is on unless the glow flags or property value 2 turn it
   off. It keeps only pixels whose destination alpha marks them as glowing [inferred].
2. Blur with 7 additive taps (blend 2), offset (0, ±2), (±1.75, ±1) and (0, 0) pixels, with
   vertex colours 0x40 / 0x48 (they sum to 480/255): `GLOW_TAPS`.
3. Accumulate the result into the third target with the glow colour. Level 0 is copied
   opaque; later levels use the glow blend mode.

Finally, 0x48cdf0 composites the accumulation over the back buffer with the glow colour. Its
alpha is the strength.

Glow state:
- defaults: colour 0xffffffff, blend 2, flags 0 (data at 0x5ba0a4);
- an HDR Scene Glow template (class 0xb345d08d, "2.f.7.7") replaces it through EXE
  interface slot +0x20 (0x48d680): alpha = p0 % × 255, colour = p1, blend = p2, flag = p3
  (`decodeSceneGlow`).

Level Properties p11 names a glow template (0x100b2160), but every retail level leaves it
null. The five templates in World Common (7:1759, 1804, 1805, 2603, 2604) are not referenced
by any placed object or template. The other RFL caller (0x100af9f0) applies a template from
its own p1.

**The mask and the default state [verified].** The level-0 down-sample's pass state sets
ALPHAREF 5, ALPHAFUNC GREATER; 0x49a940 enables the alpha test whenever the reference is
non-zero, and the state is applied because the mask passes of 0x49c030 left bit 0 set
(0x48d264..0x48d28f). So by default only frame texels whose destination alpha is above 5 / 255
enter the glow. The alpha is the mask: 0x49c030 (run before the glow, 0x49d60b) clears the
frame's alpha with a full-screen quad (colour writes alpha only, `xpsSetAlpha00`), then draws a
second quad with TFACTOR alpha 0xff, STENCILFUNC EQUAL: alpha 1 exactly where a flagged pass left
stencil 1 (§5.1, layer flag 4). A glow flag p3 (+0xc) or engine property 0x39 = 2 set the
reference to 0 instead, i.e. no test: the whole frame would glow. No retail template or setting
does that.

So the glow is **on by default** (property 0x39 = 1, the default state 0x5ba0a4: colour white,
alpha 0xff, additive) whenever the front-buffer targets exist. Level Properties p11 being null
only means no level replaces the default. Front-buffer effects are inferred to follow the Pixel
Shaders option (§3.1). Texture stage 1 is set back to DISABLE (0x49d5f5) before these passes,
so the 0x80 down-sample colour really halves.

Per level f (256, 128, 64, 32), in 256² RGBA8 targets on gamma values:
1. B = clear, then a f × f quad of the source × 0x80: the frame (level 0, alpha-tested) or the
   previous level's A (its 2f × 2f corner);
2. A = clear, then the seven taps of B, additive, colour as the weight (`GLOW_TAPS`), alpha
   from the vertex colour (stage 0 alpha SELECTARG2);
3. C: level 0 copies A over the whole 256² (blend 0, glow colour); levels 1..3 add theirs with
   the glow blend mode (2) and colour.

The composite (0x48cdf0, one screen-covering triangle) adds C × colour × alpha over the back
buffer. A flat marked area comes back about 3.4 × (0.94 + 0.89 + 0.83 + 0.78), blurred over 2,
4, 8 and 16 texels of the 256² grid. The flagged materials (120 in the retail data, every one
tinted): 38 Advanced + 15 Animating additive (effect and fire cards, marked only where their
alpha > 32 / 255), 35 + 3 opaque (lamp glass 7:1863, bulbs 4:1374, the fluorescent tubes
9:5742, lit panels), 27 + 1 alpha-blended, 1 lit opaque. (`render-data.ts glowMarked`.)

**What it does to the lamps.** The cell-block lamps' "on" table (Light Housing p32, game-logic.md
§14.4) swaps in the frosted glass 7:1863 (texture 7:581's frosted disc with the cage pattern ×
0x8a8a75, unlit: about 0.42 gamma) and the bulb 4:1374 (white × 0xffd67e). Both carry the flag.
Without the glow the glass sits at a flat mid grey behind the cage and the bulb is a flat orange
disc: the "cage with no glass" of the report. With it the glass saturates to milky white around
a blown-out bulb, and a halo spreads over the cage, the shade's rim and the wall behind, as in
the user's reference frame of a lit cage lamp (bulb 255, glass 200..250, rim 250, a haze of
40..60 around it over a black ceiling).

**Port** (`src/app/scene-glow.ts`, `surface-material.ts glowMarkMaterial`, render-data.ts
`glowMarked` / `glowMarkAlphaRef` / `sceneGlowReference`, tests `tests/scene-glow.test.ts`):
- with the Pixel Shaders option on in the Original look, the scene is drawn into a target of
  its own (the frame target's attachments: no extra pipelines), then copied to the canvas; the
  screen effects apply the glow to their own scene target;
- the mask: a quad clears the frame's alpha (colour kept), then every drawn mesh whose material
  has a flagged layer is drawn again with its mark material (colour kept, alpha 1, the flagged
  layer's alpha test) over the scene's depth (LESS_EQUAL, no depth write). Opaque surfaces in
  front hide the mark as the engine's ZERO does; blended ones drawn over it keep it (KEEP);
- the levels as above in 256..32 targets (the level-0 down-sample takes 2 × 2 bilinear taps:
  the port's frame is several times the engine's 640..1024 pixels), then the four levels are
  added over the frame (each upsampled to the screen directly; the engine stretches its 256²
  accumulation);
- `?noglow` turns it off; Enhanced mode and `?lighting=legacy` do not use it;
- a surface's mark material is a non-enumerable userData property (`src/app/glow-mark.ts`):
  `Material.clone` deep-copies userData through JSON, which turned a stored mark into a plain
  object the renderer could not draw (chapter 5 in 1c6b915). Clones that should keep glowing
  use `cloneWithGlowMark`;
- not done: the HDR Scene Glow templates (no retail caller), the destination alpha of HUD
  quads drawn after the world (the port adds the glow before the viewmodel and the HUD).

### 3.3 Black-and-white present [verified]

Renderer vtable +0x6c (0x49a160) sets +0x134. Frame end then presents through pixel shader 0,
`xvsh/xpsBW_PC.psh` (dp3 with 0.3 / 0.55 / 0.15, `GREYSCALE_WEIGHTS`). The pixel shader table
is at 0x58f1a0, and 0x435ea0 / 0x435ed0 set and clear it. The engine interface 0x594dc8 slot
+0x7c (0x4b2660) forwards to it. Its RFL caller was not traced, so the port does not use it (the security-monitor view does not
call it either, §3.7).
`xpsSetAlpha00.psh` (alpha = 0) is the other pixel shader. Its use was not traced.

### 3.4 Gamma [verified]

0x4b24f0 builds ramp[i] = ((i << 8) / 65535)^(1/g) × 65535. It is built only when the device
has a full-screen gamma ramp and g > 0. This is what `src/app/menu/graphics.ts` already does.

### 3.5 Effect layer colour (fires) [verified]

The Advanced builder (0x48ff70, 0x490046) and the Animating builder (0x48f500) store the tint
halved per channel (`(c >> 1) & 0x7f7f7f`). In the pass state (0x48fab0), a tinted layer
(+0x14 = 1) sets bit 23, which makes the renderer (0x49ae70) set stage 0 COLORARG2 =
TFACTOR. Bit 22 sets ALPHAARG2 = TFACTOR, where TFACTOR = (layer alpha << 24) | tint/2.

Stage 0 COLOROP is always MODULATE (0x49aa60). No MODULATE2X is set anywhere (a census of
every SetTextureStageState call). So:
- **a tinted layer is texture × tint/2, unlit**: the vertex lighting is replaced (stage 1 then
  doubles it, §1.8: texture × tint);
- an untinted layer is texture × the vertex lighting (oD0), additive effects included.

The engine applies an alpha test (> 2/255, D3DRS_ALPHAREF 2) to blend modes 1–6 (0x48fab0).

Port (`surface-material.ts shadePass`):
- every layer is shaded as its own pass, by `engineLightFactor` or by the halved tint
  (`tintFactor`);
- the passes are composited after shading;
- untinted additive / subtractive effects are lit by the dynamic-object light (or by baked
  colours when the mesh has them);
- blended passes discard alpha ≤ 2/255.

White-tinted detail layers (mode 6, all 40 retail ones are tinted 0xffffff) become
texture × 0.5, doubled by stage 1 (§1.8), then modulated 2× on the destination: neutral at 50 %
grey. Tinted opaque
layers (about 1 % of level triangles in 1a, e.g. lamp glow materials) draw unlit.

**Fires [verified].**
- **No light of its own.** The Fire class (Suffering.rfl, vtable 0x10154e68, update
  0x100ac6e0) has none. It grows, turns to the camera (p1), damages (p15 / p16) and sets
  victims on fire with p18 = BurnFX 4:1329.
- **Light from placed lights.** Every retail fire cluster has a placed orange Point Light
  (0xea8c40, radius 11–31 m, Lighting Effect 7:968 flicker) that the same scripts switch:
  1a 0x8aa3–0x8aa7 / 0x8808, 4b 0x8373 / 0x8375.
- **The port's own light is removed.** The port added a three.js fire light (0xff8a30,
  intensity 6–9). It is now dropped in engine mode (`fx/effects.ts`).
- **Dim cards by design.** The cards are 3 parts per model (3.2 × 3.8 m crossed quads), one
  64² Animating material each (20 fps, 48 frames). The frames are dark and mostly
  transparent: on average rgb (18, 9, 0) and alpha 8 out of 255; at peak r·a 0.63.
- **Brightness per card.** With the 0x3f3f3f tint each card adds at most ≈ 8 % (gamma) of
  red-orange. The flames show as several overlapping cards (fires are placed in clusters of
  3–5), plus the orange point light on the surroundings.

Nothing else in the original brightens them but the scene glow (§3.2): fire cards are flagged,
so their texels above alpha 32 / 255 are marked and glow. There is no MODULATE2X, and the Fire
class spawns no sprites. The faint flames in the port are therefore faithful. A visible
difference from the original would point to the cards' draw order or depth, not their
colour. In 4b the port drew dark rectangles around the bushes behind the fires both before
and after this change. These are not the fire cards (a magenta test of the fire meshes does
not cover them). They come from the foliage cards and are not investigated here.

### 3.6 Cinematic bars and subtitles [verified]

- **Letterbox**: view manager (vtable 0x594940, [0x5c5d7c]) +0x34 on, +0x38 size, +0x3c
  colour; frame end (0x48c729) fills (0, 0, w, h) and (0, H − h, w, H), h = ftol(H × size ×
  0.01) (0x4b0b30). Suffering.rfl sets size / colour once per level from Level Properties
  p36 / p37 (0x100b239f; 10 % and black in every level); sequences with flag 0x04 switch the
  bars with the player's control keys (docs/re/animation.md §6). The PC captures show the same
  10 % bars (measured 9.6–9.7 % of a 16:9 frame).
- **Subtitle box** (Interface 5:317 Subtitle Textbox, text 5:318): y 85.2 %, h 10 %, text
  71 % wide at scale 0.9 × 0.91, white, the default font. Paging (Suffering.rfl 0x10069d80,
  0x10069964): the line is wrapped into L lines; P = ceil(L / M) pages of L / P lines
  (accumulated, 0.001 tolerance), each line holding D / L s of the sound's duration D; the box
  closes at D + 1 s. Port: `src/game/sequence/cinema.ts`, `subtitles.ts`. The captures' lines
  are centred at 88.2 % of the height whether one or two (measured); the original's wrap width
  could not be reproduced from the template: the three captured pages need 496–516, 460–472
  and ≥ 554 font px with greedy wrapping (the port wraps at 71 % = 505 px, matching the first).

### 3.7 Security monitor view [verified unless marked]

There is no render-to-texture camera. The renderer's InitRenderTarget (vtable +0x30, 0x49af40,
"Invalid texture sent to InitRenderTarget!") has one caller, the shadow pass (0x4cd8c2); the
only other targets are the front-buffer ping-pong and the glow targets (§3.1, §3.2). The
monitors in the world therefore show only their own Animating Material (9:2210's 3:2526: glass
frames 3:141..146 at 60 fps, tinted 0x7f7f7f).

Looking through a monitor ("View Monitor", Suffering.rfl 0x1001b4a0 start, 0x1001b080 per frame)
draws the normal frame from the camera's matrix with the lens set to p51 (view manager
[0x1017bf30] +0x28, the old lens kept at +0xd4). Two objects ride in front of the eye, re-posed
every frame along the view axis:

- the screen, p57 or p58 (Breakable templates 3:1661 / 3:1662), p59 = 0.38 m out. The choice is
  flag 0x2000 = (camera gone or flag 0x4000) [verified]; 0x4000 is set / cleared by the monitor's
  Disable / Enable inputs (0x1001a970 / 0x1001a980). Model 3:251: a curved pane (z 0.015..0.031,
  0.484 x 0.329 m) with the Animating Material 3:2560 (alpha blend, frames 3:226 / 227 / 226 /
  228 / 226 / 229 / 226 at 60 fps: a milky glass with a dark scan line at three heights) inside a
  black bezel (3:4988, texture 10:428) that reaches to x = +-0.5 m. Model 3:252: the same bezel
  round an opaque noise texture (3:299) whose UV offset jumps through the random waveform 3:12
  at 30 Hz;
- the Warp Effect p55 (class 0x7bf808fd, template 3:1658), p56 = 0.38 m out: model 3:249, a flat
  0.53 x 0.342 m card whose own material (2:164, a cutout texture with no opaque texel) draws
  nothing by itself. On creation (0x1013a7f0) it loads its p1 texture (3:202, 64 x 64: a black
  rounded rectangle in a soft white surround) and builds a 64 x 64 field of forward differences
  of it, (h[x+1] - h[x], h[y+1] - h[y]) / 255 per texel (0x10139de0), zero inside the screen and
  non-zero round its rounded edges; p7 = 0.14 scales it, p5 = 1 asks the engine for the object's
  special pass (vtable +0x100 with 0x10). The per-frame consumer of the field was not traced
  [inferred: it offsets where the card samples the frame behind it, so the picture bends at the
  edges like the face of a tube].

The view does not end on Disable; there is no black-and-white pass (§3.3's present shader is not
called from this code) and no letterbox. p66 can name a clock text (game time "%2d:%2d:%2d",
0x1001a990); no chapter-1 monitor has one.

Port (`src/game/world/monitor-view.ts`): both screens and the warp card are built from the
templates with the surface materials, hung under the camera while viewing, drawn after the scene
without depth test. The camera's vertical angle is p51 on frames 4:3 or wider (the bezel covers
the sides) and the screens are posed so that the glass fills the picture's height [inferred:
0.38 m fills it exactly with the 4:3 horizontal angle on 16:9; with the full 60 degrees on 4:3
the glass would cover 75 % of the height]. The warp card samples the frame through the viewport
texture at screen UV + field x p7.
The feed shows Torque's whole body even when he plays in first person, and hides the
first-person arms. The original's View Monitor state ends First Person, which puts the body
model back (docs/re/player.md §7.1) [verified]. The port does this through
`PlayerController.setExternalView`.

## 4. Shadows [verified mechanism]

### 4.1 Settings

The Graphics "Shadows" option is stored at 0x5c6d00 (launcher dialog 0x439005; getter
special case 0x41301e). The cast test (0x4ceea0) switches on its value:

| Value | Who casts |
|---|---|
| 0 | nobody |
| 1 | the object whose owner is the first registered player |
| 2 | objects whose attachment lacks flag 0x2000 |
| 3 | everyone |

### 4.2 Casters

A caster has object flag bit 24 and is within the shadow distance (0x492a00). The distance
compares d² to the camera against Level Properties p14 / p15 × 2048²/1000, set through EXE
interface slot +0x18 (0x4084a0, with 24 and 150). Retail values are 15 and 30.

A caster gets a shadow object with a **256 × 256 render texture** (0x4cb600 with 0x100;
flags 0x80 / 0x100 / 0x200 from 0x492ae2). Its light-space frame and frustum are built in
0x4cd550.

Shadow records (0x14e bytes, shadow manager 0x5c9460) start (0x4cbfe0) with alpha scale 1.0,
colour 0xff000000 (black), texture size 0x40 (characters ask for 0x100) and a zero direction.
Each frame (0x4cf000) a record fades with the caster's distance to the camera: +8 = 1 inside
Level Properties p14, 0 beyond p15, linear between (0x4cf1e5); past p15 the record is dropped.
The values are 15 / 30 in every level (their unit was not resolved).

**The shadow light [verified]** (0x4cc020): the caster's light list (vtable +0x168) is walked
from its first entry, skipping lights with flag 0x100 on dynamic objects; the first light that
has a position (vtable +0x16c) gives the direction caster → light, normalised. When its up
component is below sin 45° (0x595b54) the up component is replaced by the horizontal length and
the vector normalised again: the light is raised to 45°. So a character's shadow comes from the
strongest light of its own set, the room lamp in a cinematic, and always falls downwards.
**Flag 0x100 is the flashlight's**: no EXE code sets it on a light; the Flashlight class
(Suffering.rfl vtable 0x1014c4c8) sets it on its linked Spot Light whenever it links one
(0x10013cb2, 0x100140d7). So the flashlight is ranked first in every light set (§1.3) but never
gives a character its shadow; the shadow comes from the strongest point light. A
moved switchable point light near the camera marks the records it reaches for an update
(0x4c8694 → 0x4cca10). The texture frame (0x4cd550) is built along −direction around the
caster's bounds (the caster and its attachments, 0x4ccd90): an orthographic projection.

### 4.3 Receivers

Receiving geometry is drawn again with shader flag 0x40000000 (0x436030 from 0x498b08). It
uses xvsShadowBackfaceCull.vsh with the projected texture and these constants:
- c55: light direction;
- c56: (0.3, 1/0.7);
- c57–c59: three clip planes;
- c80: shadow colour, from the shadow pass +0x60 rgb and alpha +0x28 × 255.

The vertex alpha is clamp((N·L + 0.3)/0.7) times the three plane tests. So surfaces facing
away from the light, and anything in front of the clip planes, get no shadow.

**Colour and alpha [verified]**: c80 = (pass colour & 0xffffff) | ftol(pass alpha × 255) << 24
(0x498ac1); the colour is the record's black. The alpha is set per receiving object
(0x4ce942, again 0x4cecbe): t = (d − reach / 2) / (reach / 2) with d the receiver's distance
from the caster and the reach derived from the caster's size and the shadow distance
(0x4ce583..0x4ce5ad); t ≤ 0 keeps the camera fade, 0 < t < 1 gives (1 − t) × fade × **0.66**
(0x595b60), farther receivers get no pass (`shadowReceiverAlpha`). The captures agree: the
shadow on a lit cell wall keeps about 38 % of the wall's brightness.

There are no blob shadows and no shadow volumes.

### 4.4 Port

`engine-light.ts renderShadows` renders up to 4 casters, nearest the camera first, each into
its own 256² target (bilinear) as a white silhouette along its shadow light: the strongest of
this frame's point lights at the caster (`pointLightInfluence`; the flashlight's spots carry
flag 0x100 and are skipped), raised to 45° (`shadowLightDirection`), with an orthographic frame
fitted to the caster's bounds and centred on the drawn mesh (a sequence poses a character away
from its actor's position). Casters fade between 15 and 30 m from the camera (p14 / p15 read as
metres [inferred]); characters hidden by the view culler are skipped. Casters come from the fx
system; the Shadows option is honoured.

Before, the casters were lit only by the flashlight, which hangs on the view camera: in a
cinematic it lit the scene from the film camera and threw each character's shadow straight
behind it as a hard 55 % halo. The sequence system now turns the flashlight off while the
camera is taken over [port], and characters no longer receive projected shadows (their own
silhouette darkened their legs and laps in patches) [inferred: no self-shadowing in the
captures].

Silhouettes honour cut-out materials: a caster mesh whose material has a texture and an
alpha test is drawn with that texture's alpha and test, so only its drawn texels cast. A plain
white silhouette made every card of the swaying bushes of 4b (Animating Statics, which are
casters) cast its whole quad, the dark polygons around them on the ground and fences [port; that the engine's caster pass
cuts out the same way is inferred].

The engine-lit materials sample the targets (`shadowTerm`) and darken the gamma colour by
0.66 × mask × facing (with the shadow light's direction) × camera fade × a fall-off over the
fragment's distance from the caster (full to half of 4 caster radii, 0 at 4 radii; per
fragment, so the engine's full-strength case for receivers centred near the caster is not
used: it would draw a hard ring) [port]. Overlapping shadows take the darkest, not a product.
Receivers nearer the light than the caster centre are excluded, which stands in for the
planes. No three.js shadow maps are used, which avoids the r186 WebGPU crash noted in
docs/levels.md §6.

The shadow light is the strongest point light of the caster's set; the flashlight's spots are
never chosen (flag 0x100, §4.2; `render-data.ts shadowLightIndex` is the rule on a light set).
In the 1a opening (capture 7, t 126.7 s) the inmate's shadow now falls to his right on the cell
wall, as in the capture: with I = p8 (§1.2) his cell's lamp (p8 1.8, 2 m) outranks the corridor
light (p8 12.8, 5.5 m) that won while p8 was squared.

## 5. Materials leftovers

- **Preset Material**: no retail package has a Preset template (a census of all `.odu`
  files), so nothing draws one. Not decoded further.
- **Landscape Material**: 84 templates (Landscape Textures), with one Landscape Material
  object placed. Floor splats are covered in game-logic.md §16.
- **Texgen mode 4 and p13**: the port's mode 4 / input 1 uses the view-space position,
  translation included. That is the object × camera matrix of 0x48e9f0. p13 (modes 7–9) is
  used by one retail layer (input 3, mode 8, p13 1.8), so it is not worth a per-object
  uniform.
- **UV waveforms**: no change to game-logic.md §16.
- **Sky Properties fog colour (p4 vs p5)**: not resolved. At level start the RFL sets the fog
  colour to black through EXE interface slot +0x1c (0x408400, fog object [0x5c6dfc] +0x20; RFL
  0x100b27e0). The Sky Properties path to that slot was not found in this pass.
- **Additive fog**: blend modes 2 / 4 force the fog colour to black (game-logic.md §16). The
  port now also fades additive Particle Fountain sprites and Volumetric Fog puffs to black
  (`fx.ts`), using `additiveEffectColor`.

### 5.1 Translucent passes: state, depth, order and the back buffer

Read for the report "the gas guy does not render at all": Hermes (1a #84ff) in the gas tank,
seen through the window Real_Glass (material 7:1885). Code: `render-data.ts` (`PassBit`,
`DEFAULT_PASS_STATE`, `passDepthWrite`, `passAlphaRef`, `backBufferBlend`, `tintFactorWord`,
`modelCullsBackFaces`), test `tests/re-blend.test.ts`.

**Blend factors [verified].** The switch at 0x49a990 (jump table 0x49aa3c) sets SRCBLEND /
DESTBLEND / BLENDOP as in game-logic.md §16. Mode 2 is SRCALPHA, ONE, ADD: the source is scaled
by its alpha. There is no ×2 stage and no overbright in the blend. The only doubling is texture
stage 1 (§1.8), which applies to effect passes as to any other pass.

**Pass state [verified].** The pass builder 0x48fab0 fills a state word that 0x4952a0 applies
bit by bit, only where it differs from the device's word:

| Bit | State |
|---|---|
| 0 | ALPHATESTENABLE, ALPHAREF / ALPHAFUNC (0x49a940) |
| 1 | blend mode (0x49a990) |
| 3 | ALPHABLENDENABLE |
| 6 | CULLMODE: CCW when set, NONE when clear (0x49a700) |
| 7 | LIGHTING |
| 9 / 10 | FOGENABLE / fog colour of modes 2..6 (table 0x5ba100: black, black, black, white, grey) |
| 12 | stage 0 ALPHAOP: MODULATE (texture alpha × ALPHAARG2) when set, SELECTARG2 when clear (0x49aa60) |
| 17 / 18 | ZENABLE / ZWRITEENABLE |
| 19 / 20 | STENCILPASS: KEEP, ZERO, or REPLACE (0x49a740) |
| 22 / 23 | ALPHAARG2 / COLORARG2 = TFACTOR |

Both object draws start from the word 0x63a08 (static initialisers 0x586290 → 0x6dd280 for the
dynamic draw 0x492b40, 0x586a80 → 0x6dd8d4 for the static draw 0x4930f0). It has fog, alpha-op
MODULATE, z test and z write on, and culling off.

- **Alpha.** Stage 0 alpha is texture alpha × DIFFUSE alpha. For a tinted layer it is texture
  alpha × TFACTOR alpha. TFACTOR alpha is the layer alpha (1) × the object's opacity. For an
  object below 0.99 opacity, the object draw first sets TFACTOR = opacity << 24 | 0xffffff and
  ALPHAARG2 = TFACTOR (0x498a5c..0x498aa9). For a tinted pass it then becomes the halved tint
  with that alpha (0x48fcd7). For an untinted pass the pass builder sets ALPHAARG2 back to
  DIFFUSE, so the opacity arrives through oD0.a instead (c80.w), together with the baked
  vertex alpha (§5.4).
- **Colour.** Untinted passes are texture × the vertex lighting, effect passes included.
  Tinted passes are texture × tint / 2, unlit. Stage 1 doubles both.
- **Alpha test.**
  - Modes 0 and 7: ALWAYS.
  - Mode 8: > 200.
  - Modes 1..6: > 2.
  - A mode-2 pass whose layer flag 4 is set: > 32 (0x48fb40).
  - On a translucent object, a mode 0 / 8 pass is drawn as mode 1 with the > 2 test.
- **Depth.** ZWRITEENABLE is decided by the first pass alone (pass index 0, 0x48fc56): on for
  modes 0 and 8, off for every blended mode. Later passes keep it.
- **Layer flag 4** (Advanced p5, Animating p7; the port's `depthWrite`) is not a depth write. It
  sets STENCILPASS = REPLACE (bits 19 / 20). An opaque first pass sets ZERO. The device keeps the
  stencil test on with ALWAYS / ref 1 (0x49bb61..0x49bbed). The screen-glow set-up 0x49c0f0
  draws with STENCILFUNC EQUAL and alpha-only colour writes. So the flag marks the pixels that
  glow (§3.2).
  - Data supports this. Killjoy's skins 10:782..784 carry a near-black additive layer 10:428
    with the flag set. It adds nothing, so it can only be the glow mark.
- **Culling.** The static draw sets bit 6 only for a model whose header flag word (the first
  dword of the .mdu header entry, masked 0x1c3c000 by the loader 0x483850) has bit 23. Hermes'
  model 10:92 has it. The window glass 9:2089 and the gas tank 9:2085 do not, so both are drawn
  two-sided. The glass is two layers facing opposite ways, so both of its faces add their light.
  - The static draw 0x4930f0 is the draw of every object the list (0x4a15c0) does not send to
    0x492b40 (object +0x10 bit 8 with setting 6 off), skinned characters included (it reads the
    skin instance +0xec). 0x492b40 never sets bit 6. Killjoy's 10:90 (0x1cc8012) and his
    figures 10:162 / 10:196 cull; the port draws a skinned model with the bit front faces only
    (`app/character.ts`, `tests/projector.test.ts`).
- **Translucent objects.** Both draws pass "translucent" to the pass builder when the object's
  opacity (+0xd0) is below 0.99 or +0xc bit 7 is set (0x4933b1, 0x493719, 0x492c3b). Then
  ALPHABLENDENABLE is on, and a mode 0 / 8 pass draws as mode 1 with the > 2 test. The depth
  write of pass 0 is still decided by the layer's own mode (0x48fc70 reads layer +8, not the
  substituted 1), unless object +0xc bit 31 is set (no setter found). So a fading figure with an
  opaque first pass writes depth: within its draw a farther face drawn after a nearer one is
  rejected, and with culling only its nearer front faces show. There is no depth pre-pass
  (`render-data.ts translucentPassState`).
- **Hidden channels.** When the skin instance has hidden nodes (+8 bit 0x4000000, set by the
  animator request 0x100010 at 0x470bc6), the draw ORs `0x4914a0(channel, LOD)` (the channel's
  LOD word, model +0xc8 / .mdu type-8 channel table) of each hidden channel into a mask
  (0x493698..0x4936d2), and the object draw skips mesh partition k when bit k is set (arg 13,
  0x498ee3). Killjoy's cone channels 86..90 hold bits 1..0x10 (game-logic.md §15.7.8).

**Draw order [strong].** The object list (0x4a1650..0x4a18c8) groups objects by model in 128
buckets (+0x64 & 0x7f) and draws each group. Objects flagged +0xc bit 7 (distance-faded, which
the draw treats as translucent) are collected and drawn after all the others, in list order.
There is no depth sort of translucent objects. Additive passes commute, so for Hermes and the
glass the order does not matter. The port keeps three.js's back-to-front sort of transparent
objects [port].

**The back buffer [verified].** Every blend above happens on the bytes of an 8-bit back buffer
holding gamma values. No sRGB read or write state is set anywhere, and the result saturates
after each pass. three.js blends in a linear half-float target and encodes once at the end.
The port had patched additive passes with an output that is exact over a destination of 0.1
gamma (`additiveEffectColor`). Over brighter destinations it fell short. Hermes' skin adds
texture × 0.29 × 0.85 (about +0.06 on average, +0.21 on his brightest texels). The tank behind
the window sits near 0.4 gamma, because the glass alone adds about +0.28 there. Over that, the
linear sum rose by about a quarter of the engine's. The glass' own rise kept the same size over
black, but it flattened the contrast of everything behind it. Alpha blends and modulate-2x
passes mixed the wrong values in the same way. That was the approximation at fault. The tint,
the lighting and the glass were already as the engine has them:
- 7:1885 is one untinted, lit Simple pass of white texture 7:603 at alpha 128. Its baked
  colours are 0, so it adds 0.5 × saturate(2 × oD0) of the switchable lights on it.

**Port [port].** With `?lighting=legacy` everything stays as before. Otherwise:
- **Back buffer.** The frame target is 8-bit (`BACK_BUFFER_TYPE`). The renderer's
  `contextNode.getOutput` (`engine-light.ts backBufferOutput`) encodes every material's output
  to gamma after fog, so all blending is the engine's. The output pass copies the frame without
  conversion (output colour space linear, LinearToneMapping at exposure 1, which is a
  saturate). The clear colour is given in gamma (`renderer.ts BackBufferColor`).
- **Additive and in-shader layers.** `additiveEffectColor` now returns the linear value whose
  encoding is the engine's src × alpha × (1 − fog), which is exact. Layered materials composite
  their passes on gamma values, saturated per pass (`surface-material.ts blendOver`).
- **Depth and alpha tests.** Blended passes never write depth (`passDepthWrite`), and the glow
  flag raises the additive alpha test to 32 / 255.
- **Readers of the frame.** The screen effects read and write gamma (`insanity/effects.ts`).
  The monitor warp card decodes the gamma frame it samples (`monitor-view.ts`).
- **The glow pass** reads the mark: §3.2 (`scene-glow.ts`).

**Checked in the browser** (headless Brave, `tools/playthrough.mjs --level 1a --keep`, same
views before (HEAD) and after):
- **Hermes behind the window** (420, 88.66, 469). Before, he was a faint shape in a grey wash
  over the whole pane. After, the pane still adds its +65..75 over dark areas, but the tank,
  the room behind it and Hermes keep their contrast. He reads as a pale figure in the green
  tank.
- **The second gas room** (435, 88.66, 412.5): the 7:1885 pane over a lamp-lit wall is
  brighter than before (the engine's sum).
- **Unchanged:**
  - the alpha-blended tank and cabinet glass 7:1873;
  - the fire cluster 79ed;
  - the monitor and the security-monitor view, whose warp passes the frame through unchanged;
  - the first-person arm (mean RGB within frame-to-frame variation).
- **Killjoy in 5b**, with projector 1501 on: a translucent figure at 67 %. His black glow-mark
  layers add nothing.
- **Seen from the gas chamber's north side** (422.4, 88.66, 447), Hermes stays hidden in both
  versions. Correct: that face of the tank is the solid, outward-facing panel 9:5350, and the
  tank's glass is on the witness-room side only.

### 5.2 Alpha test, blend and coverage [verified unless marked]

What decides whether a pass is opaque, cut out or blended. All of it is the pass builder
0x48fab0 (layer: +0 texture, +4 flags, +8 blend mode) and the state appliers it feeds.

- **Mode promotion.** Before anything else, a mode-1 layer whose texture's flag word (+0x1c)
  has alpha bits 16..19 = 1 becomes mode 8 (0x48fabd..0x48fada). Those bits are the .tdu
  header's alpha mode: the texture-format chooser 0x4485d0 makes a compressed texture DXT5 when
  bits 17..19 are set and DXT1 otherwise, and an uncompressed 16-bit one A1R5G5B5 for bit 16
  alone. So mode 1 on a 1-bit (DXT1 punch-through) texture is the cut-out mode 8. No other mode
  is promoted, and the Simple builder 0x48f300 copies its word 2 as the mode with no look at
  the texture, so a mode-0 pass over an alpha texture stays mode 0.
- **Blending.** ALPHABLENDENABLE (state bit 3) = mode ≠ 0, or the object is translucent
  (0x48faeb..0x48fb05). The factors are 0x49a990's (§5.1): modes 0 and 3 are ONE, ZERO, and
  mode 8 is SRCALPHA, INVSRCALPHA like mode 1.
- **Alpha test.** 0x49a940(ref, func) sets ALPHAREF, ALPHATESTENABLE = (ref ≠ 0) and
  ALPHAFUNC. Modes 0 and 7 pass ref 0, ALWAYS: the test is off. Mode 8 passes 200 GREATER,
  every other mode 2 GREATER, a glow-flagged mode-2 pass 32 GREATER. A translucent object draws
  its mode 0 / 8 passes as mode 1 (2 GREATER). The texture's alpha never enters the decision:
  **an opaque pass is drawn whole whatever its texture's alpha holds**, which in many
  materials is a reflection mask (the mode-7 layer of a Layered material) rather than
  coverage.
- **Depth.** On for a first pass of mode 0 or 8 (§5.1).
- **Punch-through texels.** Every 1-bit texture is a D3DFMT_DXT1, whose transparent texels
  decode to RGBA 0. A pass that does not cut them (mode 0) therefore shows them black; the
  only retail cases are the PoliceBoat's lettering decal 55:12 (55:11, 55 % transparent) and
  the static 7:2431 (7:709, two small holes).

**Port [port].** One decision for static and skinned surfaces: `surface-material.ts
surfaceBaseBlend` (the first textured pass's mode; a part without a decoded material still
reads its texture's alpha as cut-out coverage) and `surfaceAlphaTest` (mode 0 / 7: none; 1..6:
`passAlphaRef`; 8: `CUTOUT_ALPHA_TEST` = 0.5 with alpha to coverage and coverage mips, where
the engine has 200 / 255, so thin bars keep their width). `createSurfaceMaterial` and
`character.ts characterAlphaTest` both use them, and a skinned submesh whose single pass is
mode 7 takes the surface material (blended) instead of the lit skin. `toDataTexture` gives a
punch-through texture its black texels for every pass but a cut-out (`texture.ts
punchThroughBlack`); cut-out passes keep the colours bled from the neighbours, so their edges
filter without dark fringes. Census and renders: game-logic.md §11.4 "Torn-off doors",
follow-up; test `tests/surface-alpha.test.ts`.

### 5.3 Light shafts and pools [verified unless marked]

Read for the user report "the light beams in the insanity tutorial room are sharp and too
unnatural" (1b arena after "Camera" #247; docs/playthrough.md row 88). Census and ray-cast
scripts were scratch tools; tests `tests/light-volume.test.ts`.

**What draws the shaft [verified data].** Decoration `86c7` (template 9:5840, model 9:4284) at
the centre of the arena's floor grate (468.0, 73.58, 486.0): one Advanced pass 9:5841, mode 2,
tint 0x414530, texture 7:584 (128² DXT5, white; alpha about 133 / 255 at the floor end, v 0.96,
down to 0 from v 0.2 up, the same in every column). The model is four open boxes over the four
quarters of the grate, 2.048 m tall (outer walls leaning out from 5.1 to 6.2 m off the centre,
inner walls along the grate's cross), 88 triangles, header 0xc0000 (two-sided), baked colours
(.ldu 30:2391) with alpha 255. Over it hang Decoration `86b7` (9:4275: the ceiling grate pattern
9:1720 × 0x323524, additive, alpha 1: about +20 luma on the ceiling) and the black crack decal
`86b8`. Under the grate: Static Object `87cd` (model 12:560), Advanced 9:5897, mode 0, texture
7:596 × 0xf0ee99, **flag p5: the lit pit is glow-marked**; the grate itself is `87ce` (12:635,
cut-out 7:1012); Point Light `87d0` sits 0.28 m under it.

**How the engine draws it.**
- A tinted pass: colour = texture × tint (halved TFACTOR, doubled by stage 1), alpha = texture
  alpha × TFACTOR alpha (1); SRCALPHA, ONE on the gamma back buffer, test > 2 / 255, no depth
  write, two-sided, fog to black (§5.1, §5.2). 1b's fog starts at 27 m [data], so nothing fades
  at room distances.
- No view-angle or distance term: of the shader fragments in `xvsh/`, only four write the alpha
  register r2.w: the light footer (× c80.w, white for precomputed draws, §1.9), LandsplatAlpha
  (floor-splat depth fade, ported), ShadowBackfaceCull (projected shadows) and LightSpecularAlpha
  (alpha from the reflection vector, "for water"; its range c70 is uploaded by 0x4361b0, called
  only from the draw at 0x4aaa51, which reads its own object's p10 / p11). A static Decoration
  gets none of them [strong: the program choice for these draws was not traced bit by bit].
- So every wall adds tint × alpha(v): about +35 luma per wall at the floor, nothing at its top,
  constant across its width, so each wall ends in a hard edge, and a line of sight through two
  boxes crosses four walls (+140 near the floor). The hard sides are in the data: every light
  pool and shaft texture of 1a, 1b, 3a and 5b fades along v only (1a's cell-lamp pools 7:292 on
  40 Decorations of 1a, 1b, 2, 3b, 6b; 4:1318; 9:5841); the Light Housing cone 7:1882 (9:4189) is
  untinted, lit by its bake (about 10 / 255: dim); only the Sky / Sun cards fade both ways.
- **The glow.** The pit's pixels seen through the grate holes are marked (stencil REPLACE), and
  the shaft drawn over them keeps the mark: the pass builder sets STENCILPASS ZERO only for a
  mode-0 first pass of an object that is not translucent (0x48fb55..0x48fb93; `edx` = mode ≠ 0 or
  translucent, `ebx` = the pass index), KEEP for every other pass, cut-outs included. So the
  scene glow (§3.2) takes the pit plus the shaft's light over it, about 3.4 times over, blurred:
  the blown-out grate and the haze around the shaft of the report. Because a cut-out keeps the
  mark too, whether the grate's bars glow depends on whether the pit is drawn before the grate
  (the object list's model buckets, §5.1) [inferred]; the port hides the mark behind every
  depth-writing surface, the dimmer of the two.

**Port [verified in the browser].** Headless Brave at the user's pose (475, 73.7, 478, yaw 1.95,
1728 × 980 CSS at 2 ×; `tools/playthrough.mjs --window 1728,1117,2`, `/shot?png=1`): the frame
without the shaft, the decoded sum (ray cast through the model, alpha bilinear from 7:584, per
pass saturated) and the port's frame agree: with the scene glow off, the added light per pixel
is the prediction's (median ratio 1.000, p25 / p75 1.000 / 1.000, 1896 samples; the outliers are
wall silhouettes shifted by the camera's sub-pixel sway), and with constant-alpha and ramp
textures substituted (1.000 / 1.006). The glow then adds the rest (mean added luma over the
shaft 36 → 51). The suspects change nothing here: 8fb255e (static modes 0 / 7 only), 50740bc
(particles), 96cc5df (the grate's own lighting; the shaft is unlit), 5c3d208 (opacity below 1
only), 0b009f4 (one draw of a two-sided additive pass: the same sum). The report's screenshot is
Original (Enhanced has no scene glow; its grate does not blow out). Original is faithful and
stays as it is; Enhanced softens the sheets (docs/enhanced.md "Light volumes").

The arena shaft is tinted, and its bake's alpha is 255, so the vertex alpha does not reach it.
Other light sheets of 1b and 1c are untinted, and their bakes fade them out: see §5.4.

### 5.4 Baked vertex alpha [verified unless marked]

Found while decoding §5.3 (docs/playthrough.md row 90). Census and frame scripts were scratch
tools; tests `tests/vertex-alpha.test.ts`.

**Stage 0 alpha of every object pass.**
- The object draw 0x4986f0 (from the dynamic draw 0x492b40 and the static draw 0x4930f0) builds
  each pass's state from 0x63a08, which has bit 12 set. Bit 12 is stage 0 ALPHAOP: 0x49aa60 sets
  ALPHAOP MODULATE with ALPHAARG1 TEXTURE and ALPHAARG2 DIFFUSE when it is set, SELECTARG2
  otherwise. Neither the object draw nor the pass builder 0x48fab0 clears it (its writers in the
  renderer are special draws: 0x48d0a0, 0x4994f0, 0x4a1300 and the shadow code). So **every pass,
  first or later, of any blend mode**, has alpha = texture alpha x ALPHAARG2.
- ALPHAARG2 is bit 22 (applier 0x49ae7b..0x49aeb2: TFACTOR when set, DIFFUSE when clear). The
  pass builder sets it for a tinted layer (layer +0x14, "tint on") or a layer with flag 2, and
  clears it otherwise (0x48fc9b..0x48fd0e). No material builder sets layer flag 2 [strong: no
  writer found]. The object draw sets bit 22 for an object below 0.99 opacity (0x498aa2), but
  the pass builder runs after it and clears it again for an untinted layer.
- So an **untinted pass takes DIFFUSE alpha (oD0.a)**. A **tinted pass takes TFACTOR alpha**,
  which is the layer alpha x the object's opacity (0x48fcd7). The vertex alpha does not reach a
  tinted pass at all.

**What oD0.a holds.**
- c51 = (1, 0.5, 0, 2). xvsLightPrecomputed: r2 = v10 x c51.wwwx, so rgb x 2 and alpha x 1. The
  light fragments write only r2.xyz. The light footer: r2.w x c80.w, then oD0 = r2 x c51.yyyx,
  so rgb x 0.5 and alpha x 1.
- c80.w is the object's draw opacity: 0x436af0 writes ftol(arg x 255) into c80's alpha byte for
  every draw (0x436c54..0x436c71), and the object draw passes its opacity (+0xd0, or less while
  distance-faded, 0x4989ce) as that argument (0x498b18 / 0x498b27). For a precomputed draw the
  rgb bytes are then set to white (0x436c7f).
- Precomputed geometry (.ldu colours, and objects lit by the load-time pass): **oD0.a = vertex
  alpha x opacity**.
- Objects without colours (characters, held items, spawned models): xvsLightHeader starts r2 =
  c80, so oD0.a = opacity x opacity [verified for the fragments; strong that every such program
  starts with that header].
  - Port: `surface-material.ts` multiplies an untinted pass of such an object by the opacity once
    more (`DiffuseAlpha`, graph token `o2`). three.js applies it once, so the pass fades as
    opacity². Tinted passes (TFACTOR) and precomputed ones keep a single factor.
  - `engine-light.ts engineLightMaterial` (characters' plain skins, static models) already
    carried opacity² (its alpha is colour alpha x opacity, and three.js multiplies again).
  - Left open: an opaque or cut-out first pass keeps alpha 1 in the graph. When a faded object
    blends it, that pass fades by the opacity once instead of texture alpha x opacity²
    [port].

**The alpha byte [verified].**
- The .ldu record loader 0x487610 copies each colour dword as stored (BGRA). Nothing halves or
  repacks the alpha byte. Only the rgb is the half-light bake (§1.6).
- The load-time pass (0x4c0480) stores alpha 0xff, so objects lit at load carry no vertex alpha.
- **The translucent flag.** While loading, 0x487610 sets bit 2 of the colour resource's flags
  (+0x1c) when any colour has alpha below 0xfe and is not the zero dword (0x487722..0x48777e).
  Black with alpha 0 does not count: 1b's pit panel 87cd, and 4a's shore sheets 814d..8155,
  whose alpha-0 corners are all black.
- The object draw reads that flag (0x498861..0x498873) and draws the object as **translucent**,
  as if it were below 0.99 opacity:
  - every pass blends;
  - opaque and cut-out passes become mode 1 (SRCALPHA, INVSRCALPHA) with alpha > 2 / 255;
  - the first pass still writes depth by its own mode (0x48fc70);
  - no pass clears the glow mark (§5.3).
  Draw order does not change: the flag is not object +0xc bit 7.

**Which geometry.** Level geometry is placed objects drawn by the same object draw, merged or
not; there is no separate world mesh. Floor layers are drawn by their own landscape path
(0x4994f0, splat alpha from xvsLandsplatAlpha) and are not covered here [inferred]; their .ldu
alpha is not changed by the port. Landscape water ("Landscape Water Material", the
LightSpecularAlpha draw 0x4aa560 from 0x4a1300) has no retail use among the census surfaces.
Water Volume is an RFL class with default virtuals, drawn as an ordinary object [strong].

**Census** (all retail levels; level 7 has no .ldu): objects with an untinted pass over a vertex
alpha below 255, and objects the flag turns into a blend.

| Level | Untinted over alpha < 255 | Now blended | What |
|---|---|---|---|
| 0 | 33 | 49 | 30 harbour Water Volumes 7:1440 (alpha blend of alpha-less 7:744; vertex alpha 92..242, so 36..95 %); 3 shore sheets 7:1593 (7:396, 0..242); the 49 open-sea Water Volumes 7:1582 (tinted opaque base: blended, but texture alpha 255, so no visible change) |
| 1b | 11 | 0 | Decoration 827a and ten other 3:3103 sheets (additive 3:376, 0..88 on 827a, 0..255 on the yard sheets 8737..888c) |
| 1c | 1 | 0 | Decoration 8041 (additive 4:1940 with no alpha, vertex alpha 0..14: nearly invisible) |
| 4a | 14 | 0 | shore sheets 7:2616 (9) and 7:1528 (5) on 7:396 |
| 5a | 2 | 1 | shore 21c6 (7:2616, 0..165); Static Object 1e48 (opaque 6:210 / 23:785, 223..255: blended, its edges about 13 % see-through) |
| 6a | 29 | 0 | stream and pond Water Volumes 25:165 (0..255), 7:1440 (113..229); banks 25:145 / 25:148 / 25:151 / 25:157, 7:1435, 7:2616; foam 7:1426 / 7:1427 |
| 6b | 50 | 0 | The Beach: Water Volumes 7:1440 (0..220), skirts, banks 7:1467 / 7:2616, surf 7:1492 / 7:1497 / 7:1501 / 7:1511 |
| 8a / 8b | 11 / 1 | 0 | shore sheets 7:1528 |
| 9 | 9 | 0 | shore sheets 7:1593 |
| 10 | 10 | 0 | shore sheets 7:1593 |

Tinted surfaces with alpha-0 colours (1b 87cd, 1c's Sky / Sun 800b) take neither term.

**Port.**
- `formats/level.ts` and `world/dynamic.ts` keep the .ldu alpha in the colour attribute.
  `dynamic.ts` wrote 1 before; level parts already carried it.
- A submesh whose corners all have alpha 255 builds the same graph as before.
- One with lower alpha goes into its own bucket (`MeshPart.vertexAlpha`), and so does a record
  with the flag (`MeshPart.translucent`). Those flags reach `createSurfaceMaterial` through
  `renderer.ts` and `SurfaceMaterialCache.get`.
- `surface-material.ts shadePass` multiplies an untinted pass's alpha by the attribute's w
  (`render-data.ts passTakesVertexAlpha`). It does this for the base pass (blend, alpha test,
  the premultiplied additive colour) and for later passes (blendOver). The glow mark's test of an
  untinted flagged pass takes it too.
- `translucent` draws opaque and cut-out passes as mode 1 (`translucentPassBlend`). Depth
  writes still follow the first pass's own mode.
- Enhanced shares the pass graph, so its water and shore edges soften the same way. No extra
  vertex attribute is added: the colour attribute already had four components.

## 6. Visibility leftovers

- `tools/coverage.ts` also counts a class as referenced when its class id appears as a hex
  literal in engine code or in the decoders (`src/formats`, except the class table). This
  covers Portal (`PORTAL_CLASS` in visgraph.ts).
- Sector-tree leaf boxes that are stale or inverted are already worked around: the culler
  builds the zone boxes from the geometry (game-logic.md §18.1, §18.4). No new findings.
