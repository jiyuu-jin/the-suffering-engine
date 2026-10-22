# The Suffering engine (browser reimplementation)

A clean-room-style reimplementation of the engine of *The Suffering* (Surreal Software / Midway,
PC, 2004) for the browser, written in TypeScript on Three.js (`three/webgpu`) and Vite.

The engine reads the game's own file formats (SRSC containers, levels, models, skeletons,
animations, textures, sounds, STOMP sequences, the front-end definitions) straight from an
install at runtime, and reimplements the game logic: the object and message system, the
characters and their behaviours, weapons, insanity and reputation, saves, the campaign flow, the
menus and the HUD. Behaviour is reconstructed from the retail data and from the original
binaries' behaviour; the docs record what was found and how sure each finding is.

## No game files are included

This repository contains only engine code, tests, tools and documentation. It contains no game
data. To run it you need your own copy of The Suffering for PC.

Put the contents of the install's `app` folder (the folder that holds `LEVELS/`, `COMMON/`,
`Suffering.rfl`, ...) at `game/app/` in this repository:

```
game/
  app/          your install's app folder (LEVELS/, COMMON/, ...)
  converted/    optional: media made by `npm run bake` (cutscenes and sound)
```

`game/` is gitignored and must never be committed. Instead of `game/app/` you can also pick the
install folder in the browser (the start screen offers a folder picker) or point the tests and
tools at another location with `SUFFERING_DATA=/path/to/app`.

Videos and sounds are stored in formats browsers can't play (WMV2 in ASF, raw PCM banks).
`npm run bake` converts them once with `ffmpeg` (on `PATH` or `$FFMPEG`) into `game/converted/`.
Without that step the game runs without cutscenes and sound.

## Graphics modes

- **Original** (the default) reproduces the engine's own look: gamma back buffer, vertex
  lighting, the level's fog, and the engine's scene glow (the blurred halo around flagged
  materials such as lamp glass, bulbs and fire; turned off with the Pixel Shaders option or
  `?noglow`). See [docs/re/renderer.md](docs/re/renderer.md) §3.2.
- **Enhanced** is an opt-in modern renderer on the same levels: physically based lighting,
  real-time shadows, volumetric light and a filmic grade, with Low / Medium / High / Ultra
  quality tiers (or Auto). Pick it on the Graphics page (Graphics Mode, applied on the next
  start) or with `?gfx=enhanced&tier=high`. It uses no third-party assets. See
  [docs/enhanced.md](docs/enhanced.md).

## Getting started

Requires Node.js 22 or newer and a recent desktop browser (WebGPU, with a WebGL2 fallback).

```sh
npm ci            # install dependencies
npm run dev       # start the Vite dev server (http://localhost:5173)
npm run bake      # optional: convert videos and sounds into game/converted/
```

## Testing

```sh
npm test          # unit and data tests (node:test)
npx tsc --noEmit  # typecheck
npm run check     # typecheck + tests + browser smoke test
```

Tests that need game data skip themselves when no install is found at `game/app` (or
`$SUFFERING_DATA`), so `npm test` passes on a machine without the game. `npm run smoke` and the
other browser harnesses in `tools/` drive a headless Chromium-family browser (Chrome, Brave, Edge or
Chromium; or set `SMOKE_BROWSER`) against the dev server.

## Building

```sh
npm run build     # typecheck, then a production build into dist/
```

The build contains no game data. The site needs the game files served next to it, or the
player picks their install folder in the browser.

## Project layout

| Path | Contents |
|---|---|
| `src/formats/` | Decoders for the game's file formats (containers, levels, entities, models, skeletons, animations, textures, sounds, videos, GUI, saves, visibility graphs) and the class tables recovered from the binaries |
| `src/app/` | The browser app: entry point, renderer and lighting, physics, audio, video, input and gamepads, the game-file access layer (`gamefs.ts`), menus (`menu/`) |
| `src/game/` | The game systems: `actors/` (characters, AI, combat, special creatures), `world/` (placed objects, logic objects, doors, props), `weapons/`, `insanity/`, `sequence/` (STOMP scenes), `campaign/`, `save/`, `hud/`, `fx/`, `levels/`, `visibility/` |
| `tests/` | `node:test` suites; `tests/helpers.ts` finds the install and skips data tests without it |
| `tools/` | CLIs (format dump, entity and class census, media baking, coverage report) and headless-browser harnesses (smoke test, playthrough, campaign, level QA, gamepad end-to-end) |
| `tools/re/` | The generator for `src/formats/message-maps.ts` (reads the user's own binaries) |
| `docs/` | Architecture and reference documentation |
| `index.html` | The app page |
| `video.html` | Dev-only cutscene test bench (not part of the production build) |

## Documentation

- [docs/game-logic.md](docs/game-logic.md): object and class system, properties, messages,
  STOMP sequences, characters, rendering and lighting; the main reference
- [docs/frontend.md](docs/frontend.md): menus, loading screens, HUD, controls
- [docs/campaign.md](docs/campaign.md): campaign flow from New Game to the endings
- [docs/levels.md](docs/levels.md): the levels outside chapter 1 and the level QA harness
- [docs/playthrough.md](docs/playthrough.md): the chapter playthrough harness and its findings,
  from the bonus 0 Prelude level (unlocked by finishing the game) through all three endings
- [docs/enhanced.md](docs/enhanced.md): the optional Enhanced graphics mode
- [docs/coverage.md](docs/coverage.md), [docs/coverage-chapter.md](docs/coverage-chapter.md):
  which object classes the engine handles
- Reverse-engineering notes: [animation](docs/re/animation.md), [audio](docs/re/audio.md),
  [object model](docs/re/object-model.md), [player](docs/re/player.md),
  [properties](docs/re/properties.md), [renderer](docs/re/renderer.md),
  [saves](docs/re/saves.md)

## Legal

The Suffering and its content are the property of their respective owners. This project is not
affiliated with or endorsed by them. It ships no game assets, and it is meant to be used only
with a copy of the game you own.
