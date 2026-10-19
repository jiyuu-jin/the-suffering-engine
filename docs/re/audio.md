# Audio engine (RE notes)

Reverse-engineering notes on the sound engine of *The Suffering* (PC, 2004), for the browser
port. Addresses: **EXE** = SUFFERING.EXE (image base 0x400000), **RFL** = Suffering.rfl (image
base 0x10000000). Tags: **[verified]** = read in the code at the address given, **[strong]** =
follows from the code with one small gap, **[inferred]** = reasoned from the code and the data,
not read directly.

## 1. Architecture

| Layer | Where | What |
|---|---|---|
| Sound manager (game-facing API) | EXE global object `0x5c9478`, vtable `0x58fc10` | play / stop / fades / categories / volume. The RFL reaches it through the interface pointer `[0x1017bf78]` (vtable offsets below). |
| Device (DirectSound 8) | object pointer `[0x5dc1b8]` (= manager +0x66a), vtable `0x58fe00`, ctor `0x4441f0`, base vtable `0x58fd48` | primary buffer, 3D listener, caps, environment (reverb) parameters |
| Voice | base class vtable `0x58fad8` (ctor `0x43bc30`), DirectSound voice vtable `0x58fd98` (ctor `0x442490`) | one playing instance. Volume, fades, position, distance curve. |
| Sound data | loader `0x43d8e0`, created by the cache `0x5c9478` (find: `0x43dfd0`) | parsed 60-byte `.sdu` header plus the PCM buffer |

The device is created with `DirectSoundCreate8` (EXE `0x443b22`), cooperative level PRIORITY,
falling back to NORMAL. The primary buffer is `PRIMARYBUFFER | CTRL3D`. [verified `0x443b10`]

Useful manager vtable offsets (RFL call sites in brackets, all [verified]):

| Offset | EXE | Meaning |
|---|---|---|
| +0x50 | `0x43e980` | set category volume (cat −1 = master) [RFL `0x10007310` options] |
| +0x58 | `0x43e0a0` | fade category: (cat, attenuation 0..1, seconds) [27 RFL sites] |
| +0x5c | `0x43f3e0` | current category attenuation |
| +0x60 | `0x43ea50` | category frequency ratio (no effect on PC, §6) |
| +0x68 / +0x6c | `0x43e010` / `0x43e030` | speaker mode bits (device `0x441ce0` / `0x441d10`) |
| +0x80 | `0x43ebb0` | stop a whole category, optionally fading (seconds) |
| +0x9c | `0x440980` | play attached to an object (sound, object, flags, fade-in s) |
| +0xa0 | `0x441410` | play (sound, position, flags, fade-in s) |
| +0xc8 | `0x441200` | stop a voice, fading (seconds; 0 = at once) |
| +0xcc | `0x440950` | fade a voice in (seconds, restarting from silence) |
| +0xd0 | `0x4406b0` | set a voice's per-play volume |
| +0xf0 | `0x4407a0` | get a voice's per-play volume |
| +0x134 | `0x43e8d0` | Environment FX on/off (device +0x28) |

## 2. Sound header (`.sdu` type 2, 60 bytes) at load time [verified `0x43d8e0`]

| Header | Read as | Sound object | Meaning |
|---|---|---|---|
| +0x00 u32 | category | +0x3c | 0 Effect, 1 Ambient, 2 Music, 3 Movie, 4 GUI, 5 **GUI FX**, 6 Dialog (names: EXE category table `0x5b9b00`, 7 rows of 0x1c bytes) |
| +0x04 u32 | ×0.0001 | +0x38 | **linear amplitude** 0..1 (values under 1e-5 become 0). It is the voice's default per-play volume (`0x43c74d`: if the caller set none, `0x4406b0(voice, +0x38)`). |
| +0x08 u32 | flags | +0x1c (remapped) | 0x8 → loop; 0x10 → 4; 0x4 → 8; 0x20 → 0x10; 0x40 → 0x20; 0x80, 0x100, 0x400 kept. 0x2 and 0x10000 are dropped. |
| +0x0c u32 | | +0x54 | **priority = (value >> 4) & 0xF** (`0x43e240`, `0x440930`, `0x440c01`, `0x440e41`; 5 when the sound is missing). 0x55 → 5. The low nibble has no reader [verified none in the manager]. |
| +0x10 f32 | | +0x50 | **random pitch variation in percent**: each play draws r ∈ [−p, +p] (`0x4081d0` = a + rand()/32767·(b − a)) and sets the ratio to 1 + r/100 for r ≥ 0, else 1/(1 − r/100) (`0x43c7b3`). Dead on PC (§6). |
| +0x14 f32 | ×2048 | +0x40 | min distance (model units) |
| +0x18 f32 | ×2048 | +0x44 | max distance (model units) |
| +0x1c f32 | ×2048 | +0x48 | second distance pair (usually 1.0); copied to voice +0x44, no reader found in the volume / DirectSound path [inferred unused] |
| +0x20 f32 | ×2048 | +0x4c | second distance pair (usually 2.0); voice +0x48, same as above |
| +0x24 / +0x28 | u32 | +0x60 / +0x5c | subtitle / rumble refs |
| +0x2c u16 / +0x2e u16 / +0x30 u32 | | +0x28 / +0x30 / +0x2c | channels / bits / rate |

Voice preparation (`0x43c650`): copies min/max (+0x3c / +0x40), the pitch draw (+0x4c), the
remapped loop flag, and **a stereo sound is never 3D**: when the voice was asked to be
positional and the sound has more than one channel, the 3D flag is cleared and the "2D" flag
set (`0x43c846`) [verified]. A 2D voice gets no distance attenuation (§3).

## 3. Volume, distance and 3D

**Gain chain** [verified]:

- per-voice gain `+0x28` = per-play volume × category volume × (1 − category attenuation) ×
  (1 − master attenuation) (`0x4406b0`, `0x43e980`);
- fades: `+0x24` goes 0 → 1 (fade out, `0x43af80`, rate (1 − f)/t) or 1 → 0 (fade in,
  `0x43af30`, rate −1/t), advanced per frame (`0x43afc0`); the voice plays at (1 − f) × gain.
  Linear in amplitude. A finished fade-out stops the voice unless it is flagged "paused"
  (0x800).
- 2D voices (category flag 0x10 or stereo): volume = (1 − fade) × gain (`0x43b742`).
- 3D voices (`0x43b030`): beyond max distance → 0; else volume = (1 − fade) × gain × curve(d) ×
  edge(d) × occlusion.
- The DirectSound volume is 2000 × log10(volume) millibels, floored at 1e-5 (`0x4438c0`), sent
  with `IDirectSoundBuffer::SetVolume` (vt +0x3c) by `0x442660`, only when it moved by more
  than 0.05 (linear).

**Distance curve** (both the open-air path `0x4bf89c` and the portal path `0x4beb30`)
[verified], with `min`, `max` from the header and `w = 0.06 × (max − min)`:

- curve(d) = 1 for d ≤ min + w, else 10^(0.1 × (1 − (d − min) / w)). In dB (amplitude):
  2 − 33.3 × (d − min)/(max − min), i.e. about −31 dB at max.
- edge(d) = 1 for d ≤ min + 0.9 (max − min), then linear down to 0 at max (`0x43b1a7`).
- d is the straight distance in open air, or the path length through the visibility portals
  when the source is in another zone (the sound is then placed at the last portal: the
  "perceived position" +0x78 sent to DirectSound) [strong for the portal geometry].
- occlusion: the portal path multiplies the factors of the Sound Occlusion Templates of the
  portals it crosses (template p1 % when the portal flag is set, p3 % for a closed door, p4 %
  into a second "HF" factor) [strong, `0x4bf7a4`]; the open-air path gives 1.

**DirectSound 3D** [verified]: mono positional voices get a `CTRL3D | CTRLVOLUME |
LOCHARDWARE | MUTE3DATMAXDISTANCE` buffer (0x20094; software retry without LOCHARDWARE), 3D
algorithm `DS3DALG_NO_VIRTUALIZATION` (plain panning, no HRTF; GUID at `0x59719c`), and
`SetMinDistance(1e9)`, `SetMaxDistance(1e9)` (`0x4431f3`): **DirectSound applies no distance
rolloff; the game's curve above is the only attenuation.** The listener gets
`SetDistanceFactor(1 / world scale)`, `SetRolloffFactor(1.0)` and **`SetDopplerFactor(0)`**
(`0x443bcf`): no Doppler. Positions and velocities go to the buffer with z negated
(`0x442790`, `0x442800`). 2D buffers are `CTRLPAN | CTRLVOLUME` (0xc0).

## 4. Voice limits and stealing [verified `0x441410`]

- Limits: device +0x30 (all voices) and +0x34 (3D voices), defaults **20 and 8** (`0x444224`),
  raised to `DSCAPS.dwMaxHwMixingStaticBuffers` / `dwMaxHw3DStaticBuffers` when larger
  (`0x443c3a`).
- On play, the active voices are counted once per frame; a 3D voice counts twice when it owns a
  reverb buffer (never on PC, §5).
- When full: the new sound's priority (§2) is the threshold; the first voice with a priority
  **strictly lower** than the lowest seen so far is the victim (a 3D request skips 2D victims
  only when environment FX is on). The victim is stopped at once (`0x4410f0`). **If no voice
  has a lower priority, the new sound is not played.** No distance or age criterion.
- 3D requests (play flags without 2/4) are also dropped when the listener-relative distance²
  exceeds the global `[0x5c6df8]` (runtime value) unless flag 0x10 is given (`0x4415d6`).
- Play flags (`0x43c980`): 2 = not positional, 4 = listener-relative (2D), 8 = voice flag 0x80
  [unknown use].
- Per-category queues exist (manager +0x6a2 + cat × 0x34: list of {voice, priority, …},
  `0x440be0`): when a category's "concurrent" word (+4) is 0 only the queue head plays. It is 1
  for all seven categories (copied from the table at `0x43fb48`) and nothing sets it, so the
  queue does not limit anything in retail [verified for the init, inferred for "never set"].

## 5. Reverb / Environment FX

- **No EAX**: no EAX property-set GUID is present in either binary, and no
  `IKsPropertySet` use [verified by search]. The reverb path is the DirectX 8 **I3DL2 reverb
  DMO** (`GUID_DSFX_STANDARD_I3DL2REVERB` at `0x5970fc`): per voice, a second `CTRLFX`
  buffer (sound length + a tail, flags 0x20294) with `SetFX` and
  `IDirectSoundFXI3DL2Reverb8::SetAllParameters` (`0x4432ed`–`0x443424`, `0x4434c0`).
- Parameters (device +0x72, 12 dwords = `DSFXI3DL2Reverb`): set from the Reverb Effect
  Template by `0x443e50` (device vt +0x34): p2 Room, p3 RoomHF (both scaled by the depth, as
  amplitude), p4..p13 as stored. Depth = device +0x28 (vt +0x30, `0x444060`). Default = the
  I3DL2 "Room" preset (`0x4438f0`: −1000, −454, 0, 0.4, 0.83, −1646, 0.002, 53, 0.003, 100,
  100, 5000). Per voice Room is scaled by the depth again and RoomHF divided by the HF
  occlusion factor (`0x4434c0`).
- Who sets it (RFL): Ambient Sound (`0x10092550`, a 4-state machine: pick the side's
  environment, then ramp the depth from 0 to its percent linearly over the side's fade time)
  and Level Properties (`0x100b2ac1`, p27 template / p28 depth %) [strong].
- **Environment FX option**: settings word +0x30 bit 0x100 (`0x100073dc`) → manager +0x134 →
  device vt +0x28. On the DirectSound device that method (`0x443e30`) **always clears** the
  enable bit (device +0x20 bit 2) and rebuilds the voices; the base class setter (`0x441d30`)
  is never reached, and the constructor clears the bit too. The reverb buffer is only created
  when that bit is set (`0x442fa3`). **So the retail PC build never plays reverb**, whatever
  the option says [verified]. Default of the option: on when a device capability bit
  (`[0x1017bf70]+0x178 & 2`, probably "EAX reported") is set, else off (`0x1000742f`).
- Categories that would get reverb: Effect, Ambient, Dialog (category table column +0x18).

## 6. Pitch and panning on PC

- DirectSound voices are created without `CTRLFREQUENCY`, and the voice's frequency method
  (vt +0x40 = `0x442780`) is an empty stub: **header pitch variation, per-voice pitch and the
  category frequency (manager +0x60, used by RFL `0x10129300`) do nothing on PC** [verified].
- The 2D pan methods (vt +0x38, +0x3c = `0x442760`, `0x442770`) are empty too: 2D sounds are
  never panned; mono 2D sounds play centred [verified].

## 7. Categories, options and music

**Category table** (`0x5b9b00`) [verified]: Music, Movie and GUI carry voice flag 0x10 (2D: no
position, no distance); Effect, Ambient, Dialog are reverb-capable.

**Volume options** (settings object, RFL `0x10007310`, defaults `0x10007400`) [verified]:

| Setting | Default | Categories |
|---|---|---|
| +0x10 Effects | 1.0 | Effect, Ambient, GUI, GUI FX |
| +0x14 Dialog | 1.0 | Dialog, Movie |
| +0x18 Music | 1.0 | Music |

Linear amplitude factors 0..1 (they multiply the voice gain, §3; the audio page only clamps
them to ≥ 0). Speaker Setup is settings +0x30 bits 0 and 1 (none = Mono, 0x1 = Stereo,
0x1|0x2 = Surround; audio page `0x10053f54` / `0x10052c70`, see docs/re/saves.md): bit 0 →
device +0x3c, bit 1 → device +0x40 (bit 1 forces bit 0, clearing bit 0 clears bit 1; both on
by default). They select the pan law of 2D-positioned sounds (`0x43cd00`) [strong], which on
PC never reaches the buffer (§6). The Environment FX row lists **On first, Off second**
(choice index 0 = On) [verified by the saves pass]; bit 0x4 of the same word is Subtitles.

**Combat Music** (RFL `0x100a0260`) [verified]: playing a new track stops the current one
with a fade-out of **p7** seconds and starts the new one with a fade-in of **p6** seconds (manager
+0x9c, 4th argument). If the requested track is still alive (fading out), it is faded back in
over p6 from silence instead. At most 10 music handles; when full, the quietest one is stopped
at once. Fades are linear in amplitude (§3).

**Pause** (RFL `0x100b1ab0`): on pause the music category fades to silence over 1 s (its
previous attenuation is saved); on resume it fades back over 1 s [verified].

**Cinematics** (EXE STOMP, `0x44f6c3` / `0x44f8e2`): when a sequence drives the player object,
the music category is faded to attenuation 0.5 (gain ×0.5, −6 dB) over 0.5 s, and restored to
the saved value over 0.5 s when it ends [verified for the fades, strong for the trigger].

**Movies** (RFL `0x100640c0` / `0x10064050`, `0x100e0130` / `0x100dfe80`): categories 0, 1, 2,
4, 5 are silenced at once and Dialog faded out over 1 s while a movie plays; all are restored at
once afterwards (Movie itself untouched) [verified].

**Dialog ducking: none.** Every category fade in the RFL is one of the cases above; nothing
lowers music or effects while a line of dialog plays [strong].

## 8. AI-audible sounds

- Sound playback never feeds the AI. The AI noise list (`0x100e2e60(x, y, z, source,
  InvestigateSound)`, §15.9 of game-logic.md) is filled only from explicit InvestigateSound
  template properties, always right next to the play call [verified: all 12 call sites]:

| Call site (function) | Class / property | Notes |
|---|---|---|
| `0x100b057d` (`0x100b04a0`) | Player / NPC Material Effects p7 | footsteps, source = the walker's team |
| `0x100cbf68` (`0x100cbed0`) | Missile p16 | shot |
| `0x100cc1be` (`0x100cc140`) | Missile p14 | impact |
| `0x100ca78d`, `0x100cdd98` | Missile Material Effects p2 | surface impact |
| `0x1009ad22` (`0x1009a8c0`) | BouncingObject p64 | grenades [strong: vtable `0x10154810`, factory `0x1002383e`] |
| `0x1012cb87` (`0x1012c9a0`) | Sound Effect p8 | placed sound emitters [strong: p8 is the only object ref of the class] |
| `0x10082d22`, `0x1008314a`, `0x100b451d`, `0x100ca32a`, `0x100cad1c` | p12, p16, p38, p75, p72 of other classes | not identified |

  Every non-footstep site passes source −1.
- Hearing filter (InvestigateBehavior, `0x100ed680`) [verified]: ignore the listener's own
  noises; level ≥ the level already being followed and ≥ p4; distance² ≤ (radius × 2048 + p2)²
  (internal units); while already investigating, a new noise of the same level must be closer
  than the current target; finally `rand() % 101 ≤ p3` (`0x10071120`) — p3 is a percent
  chance.
- **STOMP sound keys** (EXE `0x450970`): only key flag bits 0x10 (play listener-relative, not
  attached) and 0x20 are read. 0x20 posts engine message **0xe** to the track's object with
  delivery flags 7 (`0x450b15`, dispatcher `0x40b260`); it does not touch the AI noise list.
  Key flag **0x08 is never read** [verified].
- In the dispatcher `0x40b260`, delivery flag **0x08** = deliver even to a disabled object
  (flag word sign bit), 0x10 = forward to attached children [verified]. The sound stimulus uses
  7, so disabled objects never receive it.

## 9. dsound.ini (game/app)

`dsound.ini`, `dsound.dll` and `dsound_readme.txt` are the **IndirectSound** wrapper
(© 2012-2014 J.-P. Ownby) bundled by GOG — not game data. It sets `hardwareBufferCount = 128`,
`eax1 = eax2 = true` (EAX presence only, no processing), `monoSourceBehavior = "center"`,
`disabled3dBehavior = "2D"`. For the game this means: the caps report 128 hardware buffers, so
the voice limits rise from 20 / 8 to about 128 / 128 (§4); 3D buffers are hardware-emulated
(multichannel panning). The EAX flags change nothing: the game never asks for EAX (§5).

## 10. Constants

| Name | Value | Meaning |
|---|---|---|
| `SOUND_VOLUME_SCALE` | 1/10000 | header +0x04 → linear amplitude |
| `SOUND_PRIORITY_DEFAULT` | 5 | priority when a sound is unknown; 0x55 → 5 |
| `priority(raw)` | (raw >> 4) & 15 | header +0x0c |
| `ROLLOFF_KNEE` | 0.06 | flat part of the curve, fraction of (max − min) |
| `ROLLOFF_EXP` | 0.1 | curve(d) = 10^(0.1 (1 − (d − min)/w)) |
| `EDGE_FADE_START` | 0.9 | linear fade to 0 over the last 10 % of (max − min) |
| `MILLIBEL_PER_DECADE` | 2000 | SetVolume = 2000 log10(v) |
| `MIN_LINEAR_VOLUME` | 1e-5 | floor before log |
| `VOLUME_EPSILON` | 0.05 | volume changes below this are not sent |
| `ENGINE_MAX_VOICES` / `ENGINE_MAX_3D_VOICES` | 20 / 8 | without hardware caps |
| `INDIRECTSOUND_VOICES` | 128 | GOG wrapper caps |
| `DOPPLER_FACTOR` | 0 | no Doppler |
| `DS3D_MIN_MAX_DISTANCE` | 1e9 | DirectSound rolloff disabled |
| `MUSIC_PAUSE_FADE` | 1 s | music out / in on pause |
| `CINEMATIC_MUSIC_ATTENUATION` / `_FADE` | 0.5 / 0.5 s | music ducking during player-driving sequences |
| `MOVIE_DIALOG_FADE` | 1 s | dialog fade when a movie starts |
| `MUSIC_HANDLES_MAX` | 10 | Combat Music handles |
| `NOISE_CHANCE_DIVISOR` | 101 | rand() % 101 ≤ p3 |
| `STOMP_KEY_NOT_POSITIONAL` / `_AI_STIMULUS` | 0x10 / 0x20 | sound key flags; 0x08 unused |
| `AI_SOUND_MESSAGE` / delivery | 0xe / 7 | stimulus posted by flag 0x20 |
| I3DL2 default | Room preset | §5 |

## 11. Proposed port changes (not applied)

Pure rules (new module, e.g. `src/app/audio-rules.ts`, no WebAudio): the constants of §10 plus
`distanceGain(d, min, max)` (curve × edge, 0 at/after max), `soundPriority(raw)`,
`pickVoiceToSteal(newPriority, voicesInStartOrder)` (index of the first voice with a strictly
lower running minimum, −1 = drop the new sound), `isPositionalSound({channels, category})`,
`linearToMillibels(v)`.

`src/formats/sound.ts`:

- `priority` = (+0x0c >> 4) & 15, keep the raw word as `priorityRaw`; `pitchVariance` = +0x10;
  category 5 name "GUI FX"; comment +0x04 as linear amplitude.

`src/app/audio.ts`:

1. Play at `opts.volume × info.volume` (header volume is the default per-play volume).
2. Distance: give each 3D handle a "distance" GainNode between `gain` and the panner, create the
   PannerNode with `rolloffFactor: 0`, and in `update()` set that gain to `distanceGain(|voice −
   listener|, min, max)` (header model units; the port's world units are the same).
3. `panningModel` default `'equalpower'` (the original used `DS3DALG_NO_VIRTUALIZATION`).
4. Ignore `opts.position` for stereo sounds and for Music / Movie / GUI categories.
5. Replace "drop the oldest one-shot" by `pickVoiceToSteal`: stop the victim at once, or return
   an already finished handle for the new sound. Keep 48 as the limit (the GOG wrapper allows
   128; 20 total / 8 3D is the no-caps engine).
6. `playMusic(keys, { fadeIn, fadeOut })`: old track `stop(fadeOut)` (linear), new one `fadeIn`
   from silence; if the requested key is the one fading out, restart its fade-in from silence;
   keep `fade` as a shorthand for both.
7. `fadeBus(bus, attenuation 0..1, seconds)` on a per-bus duck GainNode after the user-volume
   GainNode (gain = 1 − attenuation, linear ramp), mirroring manager +0x58.

Callers:

- `src/game/world/music.ts`: pass `{ fadeIn: p6, fadeOut: p7 }` of the *new* Combat Music
  object instead of `fade: 1` / `stopMusic(p7 ?? 3)`.
- `src/game/sequence/system.ts`: when a sequence drives the player, `fadeBus('music', 0.5, 0.5)`
  at start and back to the previous value over 0.5 s at the end.
- Pause: `fadeBus('music', 1, 1)`, resume: previous value over 1 s.
- Movies: sfx / music attenuation 1 at once, voice 1 over 1 s; all back to 0 at once after.
- `src/game/fx/reverb.ts`: keep as a port feature; note that the PC build never applied reverb
  (§5). With the option list On / Off, index 0 = On.
- `src/game/insanity/system.ts`: `playbackRate` pitch changes and bus ducking have no PC
  counterpart (§6, §7); keep as port features.
- AI (new pure module, e.g. `src/game/fx/ai-audible.ts`): the emitter table of §8 and a
  `hearsNoise(listener, noise, rnd)` filter with the p3 percent chance (`floor(rnd × 101) ≤ p3`)
  and the same-level "closer" rule; add the Sound Effect p8 and BouncingObject p64 emitters.

## 12. Sound Effect (placed emitter) [RFL 0x1012b..0x1012d]

What the placed `Sound Effect` object does when it gets On, in the order the code does it.

- **Play** (`0x1012c9a0`) [verified]:
  - Adds one to a play counter. In play mode 4, once the counter is past the number of
    sounds, the object destroys itself instead of playing.
  - In modes 2..4 it also arms a re-trigger timer of `p6 + uniform(-p7, p7)`, clamped to 0,
    then plus `p13` seconds.
  - Picks a sound (`0x1012c270`) and hands it to the voice (`0x1012bc80`).
- **Play mode p3** [verified]:
  - 0 plays once and posts outOnFinished (p18) when the voice ends (`0x1012ce0b`).
  - 1 repeats the picked sound until stopped. It sets voice flag 1 (`0x1012c177`), and the
    voice update restarts a finished sound while that flag is set (`0x1012bea7`).
  - 2 re-triggers on the timer with a random pick (`rand() % n`).
  - 3 re-triggers with a shuffle: no sound twice until every one has played (bit mask,
    `0x10041650`).
  - 4 is a shuffle that destroys the object after the round.
  - Each re-trigger first stops the old voice at once (`0x1012ce74`).
- **p6 / p7 are a time, not a distance** [verified]. The only readers are the interval code
  above. The voice keeps the sound header's own min / max distance: the play call
  (`+0xa0` / `+0x9c` at `0x1012bfba`) passes no range. The start is held back until the
  listener is within the header's max distance (`0x1012bf92`, distance squared against
  `+0xb0`² of the sound).
  - The port had read p6 as a radius. 1a's metal detector alarm (Sound Effect 8147, p6 = 1)
    sits in the ceiling 7.4 units above the gates, so it was always silent.
- **Same sound** [verified]: asking the voice for the sound it already has does nothing
  (`0x1012bc80` compares first). A different sound stops the current voice at once.
- **Fades** [verified]:
  - p13 is the fade-in of every start (the 4th argument of the play call).
  - Stop (`0x1012c560`) fades the voice out over p12.
- **Position p9** [verified for the flags, strong for the meanings]:
  - 0 is the object itself.
  - 1 is the point of the p11 objects nearest the listener (`0x1012c5c0`).
  - 2 is at the listener: play flag 4, a 2D voice (`0x1012c158`).
  - 3 is the p10 object.
- **Port**: `src/game/world/sound-effect.ts` (rules) and `logic.ts` `playSoundEffect`.
  - Mode 1 plays as a WebAudio loop.
  - Not modelled: p9 = 1, and holding a one-shot back until the listener comes in range.
    Out of range the port starts it silent.

**1a metal detectors** [verified data]:
- The two walk-through gates (about 374, 90, 491.2 and 494.8; 0.5 × 3 × 1.8 Detectors
  8956 / 8957, filter player, repeatable) send On to Relay 813e. That relay starts:
  - Sound Effect 8147 (3:297, volume 0.82, range 0..50, play mode 1: the alarm repeats);
  - the flashing Point Light 8148;
  - Timer 814a, which counts Count Down 814b to zero → Relay 814c Off (sound and light off) and
    re-enables 813e. Relay 814f disables 813e while the alarm runs.
- Relay 895b (the booth statue scene) destroys the player gates and enables the NPC copies
  813c / 813d (filter 2).

## 13. Footsteps

- **Third person and NPCs** [verified]:
  - Animation markers 200..205 (docs/game-logic.md §17.6) count only while their clip is
    channel 0's current clip.
  - Each plays one sound of the surface entry's list p(1 + kind) at the object's origin
    (`+0x44`), with play flags 0 and the header volume (`0x100b0585`), never the same sound
    twice in a row.
  - There is no rate limit and no volume or pitch change. Header +0x10, e.g. 9 % on the player
    lists, is the dead pitch variation (§6).
  - No code steps by distance or by time. A character whose clip has no markers is silent.
- **First person** (Move per-frame `0x100462f9..0x10046484`) [verified]:
  - While the first-person flag is set, a timer at Player `+0x186` drops by |stick| × dt.
    The stick magnitude is 0..1 (keys: 1 − Run/Walk).
  - At 0 the player posts message 200 (FootStep_Light) to itself with channel 0's clip, so the
    same handler plays it, and the timer restarts at Player p156 = 0.4.
  - The timer starts at p156 (`0x100314aa`, `0x1003bf32`). The first-person clips (2:232, ...)
    carry no markers.
  - So first person plays one light step every 0.4 s at full stick, walking or running.
- **Port** (`src/game/fx/footsteps.ts`):
  - Clip markers for everyone.
  - `fpStepTimer` in first person, with the stick taken as ground speed / 6.64 m/s
    [inferred mapping].
  - The third-person gait cycles (`actors/gait.ts`) are re-timed blends. Each fires the markers
    of the retail clip it mostly is, re-timed onto the cycle (`clipEventSource`,
    `cycleEventTime`).
  - Before this fix:
    - Every cycle reused the walk clip's id and marker times, so running played Light
      steps in pairs 0.13 s apart, then a 0.63 s gap.
    - First person had no markers and fell back to stepping by distance: a Heavy step every
      0.166 s at 6.6 m/s.
    - NPCs without markers also stepped by distance [port addition, removed].

## 14. STOMP sound keys (EXE `0x450970`)

- **Volume** [verified]: the voice plays at clamp(key u16 / 10000 × the header volume, 0, 1)
  (`0x450ab1..0x450bf7`, set with manager `+0xd0`).
- **Placement** [verified]: key flag 0x10 plays it listener-relative (play flag 4). Otherwise
  the voice is attached to the track's object (`0x440350`).
- **Registration** [strong]: every voice is registered with the running sequence
  (`0x44eb10`).
  - Once the sound is loaded, its end time is set to the start + the sound's length. When the
    clock passes it, the voice is stopped at once.
  - So a looping sound started by a key plays one pass.
- **Sequence end** [strong]: the end of the sequence (`0x44f730` → `0x44ec60`) stops all its
  registered voices at once.
- **Port** (`src/game/sequence/system.ts`, `stompKeyGain` / `stompVoiceEnd` in
  `src/app/audio-rules.ts`):
  - The clamp and the one-pass cut.
  - At the end it stops the sequence's looping voices. One-shots play out, since the port's
    sequence end time (its last key) is inferred and a line must not be cut.
- **Electric sounds**: before this fix, looping hums started by sequence keys never stopped.
  - The 1a Horace scene STOMP 80d2 keys 10:695: volume 1.0, range 1..125, full volume within
    8.4 units. It stayed on for the rest of the level, on top of Sound Effect 89f6's copy of
    the same loop.
  - Measured in the browser: two copies of 10:695 still live after the scene.
