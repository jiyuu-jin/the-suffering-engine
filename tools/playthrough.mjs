// End-to-end playthrough QA of chapter 1 in a headless Chromium-family browser.
//
//   node tools/playthrough.mjs [--url http://localhost:5173] [--tmp <dir>] [--shots <dir>]
//        [--out report.json] [--from <step id>] [--to <step id>] [--keep] [--ctl 9333]
//        [--watch <s>] [--invulnerable] [--ignore-player] [--level 1b|1c] [--difficulty 0..3]
//        [--window W,H[,device scale]]
//
// --tmp holds the browser profile and the dev server's config / cache (deleted at exit);
// --level starts that level through the developer deep link (no menus, no carried inventory)
// and runs its steps only (--level 0, the Prelude: New Game through the menus with the profile's
// prelude unlock, as after Game Finished; --direct deep-links it). --difficulty picks the New Game difficulty (0 Easy .. 3 Impossible,
// default 1 Medium) with the arrow keys, or passes it to the deep link.
//
// Boot page -> start gate (mouse click) -> logo movie (Esc) -> copyright -> main menu (Enter) ->
// difficulty Medium (Enter) -> 1a, then the scripted route (ROUTE below): every step is an
// objective the way a player reaches it - walking with the move key (W held through CDP key
// events while the page turns the view along a path planned over the collision world; closed
// doors on the way are opened with E), using objects with E, picking items up with E, fighting
// with services.weapons.fire (the mouse button needs pointer lock, which headless Chrome has
// not got), watching / skipping cinematics with Enter. Teleports and other shortcuts are logged
// as such with their reason.
//
// After every step: console errors / exceptions since the last step, player alive / health /
// position, objective checks (expect), cinematics and checkpoints seen, music and ambience,
// fps / draw calls, actors near the player floating / sunk / stuck, a screenshot (steps with
// `shot`). Three save / load round trips (pause menu Save Game and Load Game through the menu
// flow) compare doors, items, actors, sequences, reputation / insanity and inventory.
//
// --deaths <step,...> | ch1: after each of those steps the player is killed (a logged, deliberate
// death, invulnerability off) and the game restores its own last checkpoint. The restored level
// is compared with the state captured in the frame the checkpoint was taken
// (tools/playthrough-restore.js: world entities, actors, dynamic objects, props, insanity,
// weapons, the player controller); the route then goes on from the step that took that
// checkpoint, so the steps after it must pass on the restored level. `ch1` dies twice in each
// of 1a, 1b and 1c (DEATH_POINTS).
//
// --keep leaves the browser up after the route with a small control server on --ctl
// (POST /eval, POST /key {code,type}, GET /shot?name=, GET /logs?since=, GET /inject,
// GET /step?id=<route step>, GET /quit) for exploring the next part of the route by hand.
// Bug log and findings: docs/playthrough.md.
//
// Browser: $SMOKE_BROWSER, else Brave / Chrome / Edge / Chromium. Brave is started with
// --disable-component-update --disable-background-networking (its updater downloads into the
// temp dir otherwise) and a throw-away profile with the caches off, deleted at exit. Game data
// is read by the dev server at runtime; nothing of it is written anywhere.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const has = (k) => args.includes(k);
const TMP = opt('--tmp', tmpdir());
const shotsDir = opt('--shots');
const outPath = opt('--out');
const fromStep = opt('--from');
const toStep = opt('--to');
const keep = has('--keep');
const ctlPort = Number(opt('--ctl', '9333'));
const WATCH = Number(opt('--watch', '15'));
// --level 1b: start that level through the developer deep link (no menus) and run its steps.
const startLevel = opt('--level');
const DIFFICULTY = Math.max(0, Math.min(3, Number(opt('--difficulty', '1')) | 0));
// --ignore-player: the port option "Enemies ignore the player" (`?ignorePlayer=1`), a testing aid
// (exploring, checking level logic past a fight); never for the official campaign results.
// Separate from --invulnerable (which keeps the player alive but lets enemies fight him).
const IGNORE_PLAYER = has('--ignore-player');
// --query 'gfx=enhanced&tier=high': extra URL parameters for every page load (docs/enhanced.md).
const EXTRA_QUERY = [opt('--query', ''), IGNORE_PLAYER ? 'ignorePlayer=1' : ''].filter(Boolean).join('&');
const DIFFICULTY_NAMES = ['Easy', 'Medium', 'Hard', 'Impossible'];
// --deaths: steps after which the player dies on purpose (checkpoint restore check). Each point
// follows a checkpoint by a few steps: 1a after the first CartWheeler fight and in the gas
// chamber, 1b on the ledges (the arena death of the last full run) and at the crate, 1c in the
// yard and in the east yard (the inmate's escort).
const DEATH_POINTS = { ch1: ['1a.flashlight', '1a.gas', '1b.ledges', '1b.crate', '1c.yard', '1c.east'] };
const DEATHS = new Set((opt('--deaths', '') ?? '').split(',').flatMap((k) => DEATH_POINTS[k] ?? [k]).filter(Boolean));

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = netServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}
const hex = (n) => n.toString(16);
/** `--level` id (1a, 2, 3b ...) -> the .lvl path under the game's LEVELS folder. */
const levelPath = (id) => {
  const dir = join(ROOT, 'game/app/LEVELS');
  const num = id.match(/^\d+/)?.[0];
  const sub = readdirSync(dir).find((d) => d.split(' ')[0] === num);
  const file = sub && readdirSync(join(dir, sub)).find((f) => f.toLowerCase().endsWith('.lvl') && f.split(' ')[0] === id);
  if (!file) throw new Error(`no level ${id}`);
  return `LEVELS/${sub}/${file}`;
};
/** Levels a player enters through a transition: started from the level before (see --level). */
const ARRIVALS = {
  2: { from: '1c', transition: 0x7813, kit: 'chapter 2' },
  // Chapter 3: 3a from 2's exit 11aa (NorthEast Spawn); 3b from 3a's door 16c1 (Timer 18dd ->
  // 18dc, West Spawn). `kit`: what a player carries in by then (item templates, given and logged).
  '3a': { from: '2', transition: 0x11aa, kit: 'chapter 3' },
  '3b': { from: '3a', transition: 0x18dc, kit: 'chapter 3' },
  // Chapter 4: 4a from 3a's exit door 3633 (Timer 431d -> Level Transition 18e3, "SouthWest
  // Spawn" 6888); 4b from 4a's Detector 6caf -> Level Transition 6cb1 (no spawn name: 4b's Player
  // Spawn Point from 4a).
  '4a': { from: '3a', transition: 0x18e3, kit: 'chapter 4' },
  '4b': { from: '4a', transition: 0x6cb1, kit: 'chapter 4' },
  // Chapter 5: 5a from 4b's Level Transition 78b5 (Detector 78b3, "East Spawn"); 5b from 5a's
  // asylum door ed9 (p68 / p69 -> Timer 1a85 / Relay 2345 -> Level Transition 167f, "North Spawn").
  '5a': { from: '4b', transition: 0x78b5, kit: 'chapter 5' },
  '5b': { from: '5a', transition: 0x167f, kit: 'chapter 5' },
  // Chapter 6: 6a from 5b's Level Transition 13c1 (Detector 13c2, "West Spawn" 1419); 6b from 6a's
  // Detector 1a87 -> Level Transition 1a88 ("NorthEast Spawn" 137c).
  '6a': { from: '5b', transition: 0x13c1, kit: 'chapter 6' },
  '6b': { from: '6a', transition: 0x1a88, kit: 'chapter 6' },
  // Chapter 7, the return to prison (block owned by the chapter 7 route). `level`: the level
  // arrived in when the id is not one (r1b / r1a: the chapter 1 levels revisited); `mail`: what
  // the level before posts to its Level Transition Msg Handlers on the way out ([handler,
  // message, sender]: 6b's Detector 1e54 -> 1e55 12:0, 1b's Relay 7ca5 -> 7ca9 11:0). 6b's
  // Detector d50 -> Level Transition d51 ("North Spawn" 7ca3, the sewer); 1b's door 79b2 ->
  // Timer 8b79 / Relay 8c0c -> Level Transition 8b7a ("South Spawn" 79b5). --visited <capture>
  // puts the levels a capture holds into the session first, as a player's earlier visits.
  // Level 7 (the test map) is started directly; `kit` without `from`: the 22 pickups its Player
  // object links (they float 10 m over the beach, out of reach), given at the start (logged).
  7: { kit: 'level 7' },
  r1b: { from: '6b', level: '1b', transition: 0xd51, mail: [[0x1e55, 1, 0x1e54]], kit: 'chapter 7' },
  r1a: { from: '1b', level: '1a', transition: 0x8b7a, mail: [[0x7ca9, 1, 0x7ca5]], kit: 'chapter 7' },
  // Chapter 8: 8a from 3a's Level Transition 2e93 (the revisit's exit, "SouthEast Spawn" 1aa2); 8b
  // from 8a's Detector 1b70 -> Level Transition 1d60 (no spawn name: 8b's Player Spawn Point from 8a).
  '8a': { from: '3a', transition: 0x2e93, kit: 'chapter 8' },
  '8b': { from: '8a', transition: 0x1d60, kit: 'chapter 8' },
  // Chapters 9 / 10 (block owned by the chapter 9-10 route): 9 from 8b's Detector 1f2f -> Level
  // Transition 1798 (no spawn name: 9's Player Spawn Point ca5 from 8b); 10 from 9's Detector ca7 ->
  // Level Transition ca6 (off at start: Enable from Relay 19e7 when the companion bc9 reaches
  // Waypoint e08; carries him, 3017 = bc9). `mail`: 9's Detector cab posts On to Level Transition Msg
  // Handler 19ea (10:1) on the way, which 10's handler 1245 reads.
  '9': { from: '8b', transition: 0x1798, kit: 'chapter 9' },
  '10': { from: '9', transition: 0xca6, mail: [[0x19ea, 1, 0xcab]], kit: 'chapter 9' },
};
const KITS = {
  // Out of chapter 1: the guard's revolver (1a) with 12 rounds, the shiv, the flashlight with a
  // spare battery, one Xombium bottle.
  'chapter 2': { items: [['4:5', 1], ['4:230', 12], ['4:79', 1], ['4:72', 1], ['4:203', 1], ['4:207', 1]], equip: '4:5' },
  // Revolver + 24 rounds, the shiv, the flashlight with two spare batteries, two Xombium bottles.
  'chapter 3': { items: [['4:5', 1], ['4:230', 24], ['4:79', 1], ['4:72', 1], ['4:203', 2], ['4:207', 2]], equip: '4:5' },
  // Out of chapter 3: the revolver and 48 rounds, 3a's shotgun (4:84) and 28 shells, the shiv, the
  // flashlight with two spare batteries, two Xombium bottles (4a's level-select kit adds the
  // Tommy Gun, which 4a itself places).
  'chapter 4': { items: [['4:5', 1], ['4:230', 48], ['4:84', 1], ['4:231', 28], ['4:79', 1], ['4:72', 1], ['4:203', 2], ['4:207', 2]], equip: '4:84' },
  // Into chapter 5: 5a's own level-select kit (the pickups its Player object links: two revolvers
  // and 48 rounds, the shotgun and 28 shells, the Tommy Gun and 192 rounds, the flashlight and two
  // batteries, four TNT sticks, four Flash/Bangs, four flares), plus the shiv and two Xombium bottles.
  'chapter 5': { items: [['4:5', 2], ['4:230', 48], ['4:84', 1], ['4:231', 28], ['4:260', 1], ['4:255', 192], ['4:79', 1], ['4:72', 1], ['4:203', 2], ['4:236', 4], ['4:284', 4], ['4:455', 4], ['4:207', 2]], equip: '4:84' },
  // Into chapter 6: the chapter 5 kit (5b's own pickups on the way are not added).
  'chapter 6': { items: [['4:5', 2], ['4:230', 48], ['4:84', 1], ['4:231', 28], ['4:260', 1], ['4:255', 192], ['4:79', 1], ['4:72', 1], ['4:203', 2], ['4:236', 4], ['4:284', 4], ['4:455', 4], ['4:207', 2]], equip: '4:84' },
  // Level 7's Player object kit: two revolvers, 4 x 24 rounds, the shotgun, 2 x 28 shells, the
  // shiv, the Fire Axe, four TNT sticks, four Flash/Bangs, the flashlight and 2 x 2 batteries.
  'level 7': { items: [['4:5', 2], ['4:230', 96], ['4:84', 1], ['4:231', 56], ['4:79', 1], ['4:240', 1], ['4:236', 4], ['4:284', 4], ['4:72', 1], ['4:203', 4]], equip: '4:84' },
  // Into chapter 7 (the return to prison): the chapter 6 kit, the Fire Axe (5b / 6a) and Molotovs
  // (6a / 6b, Clem's four among them).
  'chapter 7': { items: [['4:5', 2], ['4:230', 48], ['4:84', 1], ['4:231', 28], ['4:260', 1], ['4:255', 192], ['4:79', 1], ['4:240', 1], ['4:72', 1], ['4:203', 2], ['4:236', 4], ['4:284', 4], ['4:249', 8], ['4:455', 4], ['4:207', 2]], equip: '4:84' },
  // Into chapter 8: 8a's own level-select kit (the pickups its Player object links: two revolvers
  // and 72 rounds, the shotgun and 30 shells, the Tommy Gun and 144 rounds, the shiv, the Fire Axe,
  // the flashlight and two batteries, four TNT sticks, two Flash/Bangs, three flares, two Molotovs),
  // plus two Xombium bottles.
  'chapter 8': { items: [['4:5', 2], ['4:230', 72], ['4:84', 1], ['4:231', 30], ['4:260', 1], ['4:255', 144], ['4:79', 1], ['4:240', 1], ['4:72', 1], ['4:203', 2], ['4:236', 4], ['4:284', 2], ['4:455', 3], ['4:249', 2], ['4:207', 2]], equip: '4:260' },
  // Into chapters 9 / 10 (block owned by the chapter 9-10 route): the chapter 8 kit.
  'chapter 9': { items: [['4:5', 2], ['4:230', 72], ['4:84', 1], ['4:231', 30], ['4:260', 1], ['4:255', 144], ['4:79', 1], ['4:240', 1], ['4:72', 1], ['4:203', 2], ['4:236', 4], ['4:284', 2], ['4:455', 3], ['4:249', 2], ['4:207', 2]], equip: '4:260' },
};

// ---------------------------------------------------------------------------------------------
// Route: chapter 1 as a player plays it. Positions are output-space (the world system's) feet
// positions; uids are the level's hex uids. `expect` is checked after the step:
//   played: STOMP Player uids that must have played; destroyed / open / taken: entity uids;
//   checkpoint: true = a checkpoint taken during the step, a uid = that Autosave taken by the end
//   of the step; level: level stem.

const L1A = 'LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl';

// `diag`: a page expression whose text is added to a step's problems when it fails (the cause).
// 1a's guard 609e only goes on when the level logic before him has run: his chatter
// SimpleConversation 7520 ends only through Detector 7523 at the west end (Relay 8ab9 ->
// 837d -> Behavior Changer 7521 -> 7522 -> WaypointBehavior 7524), which taking the flashlight
// 6978 enables (Relay 8aba); after the gate ambush he talks (7528) and walks to the door
// controls only when Count Down 73a5 reaches zero (CartWheelers 64ee and 64f1; 64f1 comes
// through door 4e48 on WaypointBehavior 8027). A failed escort step names which one is missing.
const ESCORT_1A_DIAG = `(() => {
  const w = __world.world, M = __actors.manager, h = (u) => u.toString(16);
  const act = (u) => M.actors.find((x) => x.entity?.uid === u);
  const desc = (u) => { const a = act(u); if (!a) return h(u) + ' gone'; const b = a.behavior; return h(u) + ' ' + (a.alive ? 'alive' : 'dead') + ' ' + (b ? b.cls + (b.uid ? '#' + h(b.uid) : '') : '-') + ' ' + a.state + ' @' + a.position.x.toFixed(1) + ',' + a.position.z.toFixed(1); };
  const out = ['guard ' + desc(0x609e)];
  if (!w.get(0x6978)?.s.taken) out.push('flashlight 6978 NOT taken: Detector 7523 is enabled only by taking it, so his chatter 7520 never ends');
  else if (!w.get(0x7523)?.destroyed) out.push('Detector 7523 (west end) not crossed: 7520 -> 7522 -> escort 7524 not started');
  const cd = w.get(0x73a5);
  if (cd && !cd.destroyed) out.push('ambush Count Down 73a5: ' + cd.s.count + ' left (' + [0x64ee, 0x64f1].map(desc).join('; ') + '; door 4e48 ' + (w.get(0x4e48)?.s.open ? 'open' : 'shut') + '): the guard waits in his Hostility');
  return out.join(' | ');
})()`;

// A companion's state for a failed escort / follow step: where he is, his behaviour, his health
// and what hurt him last (__pt.allyDmg).
const allyDiag = (uid) => `(() => {
  const a = __actors.manager.get(${uid}), h = (u) => u.toString(16);
  if (!a) return '${uid.toString(16)} gone';
  const b = a.behavior, q = a.position, p = __player.position;
  const hurt = __pt.allyDmg.filter((d) => d.uid === '${uid.toString(16)}').slice(-4).map((d) => d.amount + ' by ' + d.by + ' @' + d.t).join(', ');
  return '${uid.toString(16)} ' + (a.alive ? 'alive' : 'dead') + ' hp ' + a.health.toFixed(0) + ' ' + a.state + ' ' + (b ? b.cls + (b.uid ? '#' + h(b.uid) : '') : '-') + ' @' + [q.x, q.y, q.z].map((v) => v.toFixed(1)).join(',') + ' (' + Math.hypot(q.x - p.x, q.z - p.z).toFixed(1) + ' m)' + (hurt ? '; hurt: ' + hurt : '');
})()`;

const ROUTE = [
  {
    id: '1a.intro',
    obj: 'watch the opening, then skip it (Enter); the cell door gives way',
    do: 'intro',
    watch: WATCH,
    then: { until: `!!__world.world.get(0x5b9e).s.played`, timeout: 20, wait: 2 },
    expect: { played: [0x7509, 0x5b9e] },
    shot: true,
  },
  { id: '1a.cell', obj: 'step out of the cell', do: 'walk', to: [399, 97.7, 507.5], tol: 0.4 },
  {
    id: '1a.guards',
    obj: 'look down the corridor: the guard scenes play, the opposite cell door falls',
    do: 'look',
    at: [409, 99, 508],
    then: { until: `__world.world.get(0x5872).destroyed && !__world.world.activeCutscenes().length && __player.enabled`, timeout: 90 },
    expect: { played: [0x7b08, 0x5824], destroyed: [0x5872] },
    shot: true,
  },
  // Looking at the Shiv (Ammo Box 5bfb) takes it through Quest Item Pickup 8368, whose p27
  // timers (0.98 s) BlowUp the stabbed inmate 7652: he dies through his own DeathBehavior 12:287,
  // clip 12:107 (3 s: rises, writhes, sinks back onto the bed). docs/game-logic.md §11.5.
  // The spot's use animation (2:511) hands the Shiv over at its EndInteract, ~1 s after the use.
  { id: '1a.shiv', obj: 'take the shiv from the corpse', do: 'pick', uid: 0x8368, aim: 0x5bfb, then: { wait: 1.5 }, expect: { taken: [0x8368, 0x5bfb], weapon: '4:79' } },
  {
    id: '1a.shiv-inmate',
    obj: 'pulling the shiv kills the inmate on his bed: his death clip 12:107 plays out',
    do: 'wait',
    until: `(() => { const a = __actors.manager.get(0x7652); const c = a && a.ch.clips[a.anim]; return !!c && !a.alive && /#107$/.test(c.name) && a.action.time >= c.duration - 0.02; })()`,
    timeout: 8,
  },
  { id: '1a.door-scene', obj: 'leave the cell (the corridor bar door scene)', do: 'walk', to: [393, 97.7, 504.4], expect: { played: [0x5e71] } },
  { id: '1a.batteries', obj: 'flashlight batteries by the guard room', do: 'pick', uid: 0x7822, optional: true },
  // The guard post hall as a player meets it (bug 28): walked, not run, with the view turned
  // by hand towards where he goes (no planner, no look-at), the hall door opened with E. "Gaurd"
  // #86 (5da5) starts when the hall's far end comes on screen from its north corner (Visiblity
  // Message Filter 6a86 via Detector 6a85) or on crossing Detector 5da4 into the hall: a guard
  // runs up, calls out to the player (voice line 12:18) and runs east. Following him, "Gaurd"
  // #114 (6045) starts when the east walkway comes on screen from the junction (filter 6c7c via
  // Detector 6c7d; or on stepping into it, 5bb1, or past the junction, 8a1e): a second voice line
  // (12:20) and the ceiling comes down on him, 16 m east of his origin (clip 12:71); a Destroy
  // key removes him under the rubble at 1.44 s. Both scenes must show him: the time he is drawn
  // on screen while each runs is measured (half-angle filters started #114 as the player entered
  // the junction facing south: 0.05 s of 1.44).
  {
    id: '1a.guard-post',
    obj: 'walk into the guard post hall and follow the guard east: he calls the way out, the ceiling comes down on him',
    do: 'stroll',
    gait: 'walk',
    turn: 3.5,
    via: [[416.5, 97.7, 505.5], [428.6, 97.7, 507.6], [434, 97.7, 509.5], [435, 97.7, 524], [435, 97.7, 537.6], [441, 97.7, 538]],
    watchScenes: [[0x5da5, 0x7508, 3.0], [0x6045, 0x7508, 1.44]],
    settle: 1.5,
    expect: { played: [0x5da5, 0x6045], scenes: [[0x5da5, 1.5], [0x6045, 0.7]] },
    shot: true,
  },
  { id: '1a.junction', obj: 'back to the junction (the Winded Guard trigger)', do: 'walk', to: [435, 97.7, 536] },
  { id: '1a.gaurd', obj: 'watch the trapped guard (Gaurd scene)', do: 'look', at: [428.1, 99.3, 538.1], then: { cine: true }, expect: { played: [0x6045, 0x6206], aliveAtStart: [[0x6206, 0x609f]] }, shot: true },
  {
    // Shortcut (services.actors.damage, 15 blows over ~3 s): a body killed by a script stays dead
    // when hit - no hit reaction, no fighting back (docs/game-logic.md §15.12).
    id: '1a.corpse',
    obj: 'hit the guard the Gaurd scene killed: he stays dead',
    do: 'wait',
    until: `(() => { const a = __actors.manager.get(0x609f); if (!a) return false; window.__corpseHits = (window.__corpseHits ?? 0) + 1; __actors.services.actors.damage(a, 30, __player.position.clone(), 'player'); if (a.alive || a.provoked || a.inCombat) throw new Error('the dead guard came back: ' + a.activity); if ([...__world.world.ents.keys()].some((u) => u >= 0x7d000000)) throw new Error('the corpse dropped a weapon (it holds none: p53 0)'); return window.__corpseHits >= 15; })()`,
    timeout: 10,
  },
  { id: '1a.wall', obj: 'the wall breaks (843a)', do: 'walk', to: [435, 97.7, 545], then: { wait: 3 }, expect: { played: [0x843b] } },
  { id: '1a.lever', obj: 'pull the lever that opens the gate', do: 'use', uid: 0x74f9, then: { wait: 2 }, expect: { open: [0x6078] } },
  // The ceiling rubble of "Gaurd" #114 closes the corridor east of the post: Invisible Static
  // Objects 72c2 / 7658 / 7659 (player clips, src/game/world/blockers.ts). Swept with the player's
  // collision layers along three lanes of the corridor; a hit short of x 448 means it blocks.
  {
    id: '1a.rubble',
    obj: 'the fallen rubble east of the guard post blocks the way',
    do: 'wait',
    until: `(() => { const c = __view.collision, L = c.queryLayers; c.queryLayers = __player.motor.layers; const ok = [536.2, 538, 539.8].every((z) => { const h = c.sphereCast(440, 98.4, z, 0.35, 1, 0, 0, 20); return !!h && h.point[0] < 448; }); c.queryLayers = L; return ok; })()`,
    timeout: 5,
  },
  { id: '1a.cp1', obj: 'first checkpoint', do: 'walk', to: [426.3, 97.7, 537.9], then: { wait: 2 }, expect: { checkpoint: 0x8393 } },
  { id: '1a.save1', obj: 'save / load round trip (mid-1a)', do: 'saveLoad', label: 'mid-1a' },
  { id: '1a.cartwheeler', obj: 'west corridor: the CartWheeler scene, then the fight', do: 'walk', to: [406.9, 97.7, 546.9], then: { cine: true, fight: 40 }, expect: { played: [0x5dac] }, shot: true },
  { id: '1a.health', obj: 'pick up the Xombium bottle', do: 'pick', uid: 0x6ff5, optional: true },
  { id: '1a.flashlight', obj: 'the office: take the flashlight', do: 'pick', uid: 0x6978, expect: { taken: [0x6978] } },
  { id: '1a.escort', obj: 'meet the guard at the west end; he leads the way', do: 'walk', to: [381, 97.7, 540.2], then: { wait: 6 }, diag: ESCORT_1A_DIAG },
  // The player goes on alone; the guard escorts (WaypointBehavior 7524, p8 the player, p9 10 m /
  // p10 20 m) and walks his waypoints (8316 at the gate) while the player keeps within 10 m, then
  // opens the gate. Whether he comes after the player depends on where his chain is when the
  // player leaves: SimpleConversation 7522 walks him to the listener; once 7524 runs, a player
  // beyond 20 m is only beckoned (the escort rule, docs/game-logic.md §15), and the step waited
  // 150 s for nothing (also with the committed code). So the player answers: he goes back to the
  // guard and keeps by him until the gate is open.
  { id: '1a.ahead', obj: 'go on alone, down to the gate (the guard stays behind)', do: 'walk', to: [404.5, 88.7, 553.4] },
  { id: '1a.guard-comes', obj: 'back to the guard: he walks to the gate and opens it', do: 'follow', uid: 0x609e, until: `!!__world.world.get(0x7f48)?.s.open`, timeout: 150, diag: ESCORT_1A_DIAG },
  {
    id: '1a.follow',
    obj: 'follow the guard down the stairs and through the gate he opens',
    do: 'follow',
    uid: 0x609e,
    until: `(() => { const a = __actors.manager.actors.find((x) => x.entity?.uid === 0x609e); return !a || a.health <= 0 || a.motor.position.x > 418; })()`,
    timeout: 150,
    expect: { open: [0x7f48] },
    shot: true,
    diag: ESCORT_1A_DIAG,
  },
  { id: '1a.ambush', obj: 'the CartWheeler ambush by the gate', do: 'walk', to: [423.8, 88.7, 557.5], then: { wait: 3, fight: 40 }, diag: ESCORT_1A_DIAG },
  { id: '1a.ammo', obj: 'revolver ammo in the booth', do: 'pick', uid: 0x865a, optional: true },
  // After the ambush the guard talks, walks to the electrified door controls (Waypoint 752d) and
  // is killed by the shock (Damage Action Objects 75dd / 8185); his pistol falls as a revolver
  // pickup (actors/drops.ts).
  { id: '1a.guard-dies', obj: 'follow the guard to the door controls: he is electrocuted', do: 'follow', uid: 0x609e, fight: true, then: { wait: 1.5 }, shot: true, until: `(() => { const a = __actors.manager.actors.find((x) => x.entity?.uid === 0x609e); if (a && a.health <= 0) __pt.aimAt(a.motor.position.x, a.bottom + 0.3, a.motor.position.z); return !a || a.health <= 0; })()`, timeout: 120, diag: ESCORT_1A_DIAG },
  // The drop is checked as the player meets it (drawn, lit, on screen; a frame '-seen'), then taken
  // with E like any pickup.
  { id: '1a.guard-gun', obj: "take the guard's dropped revolver", do: 'pickNear', cls: 'Ammo Box', at: [429.5, 88.7, 529.3], radius: 3, expect: { weapon: '4:5' } },
  { id: '1a.crates', obj: 'smash the crates blocking the way west', do: 'break', uids: [0x8153, 0x80eb, 0x80ee], from: [424.3, 88.7, 539.5], expect: { destroyed: [0x8153] } },
  { id: '1a.cp2', obj: 'second checkpoint (lower west corridor)', do: 'walk', to: [396, 88.7, 535.5], then: { wait: 2 }, expect: { checkpoint: 0x8395 } },
  { id: '1a.north', obj: 'north along the lower corridor into the lobby', do: 'walk', to: [395.7, 88.7, 488] },
  // The lobby's metal detector (docs/re/audio.md §12): walking through gate Detector 8956 ->
  // Relay 813e -> Sound Effect 8147, the alarm 3:297 repeating until Count Down 814b stops it
  // 15 s later. Heard means a live voice in the mixer, not only a play call: the lobby sparks'
  // generator 81f2 used to start a looping hum every 0.1 s, the 48 voices filled up and the alarm
  // was dropped (Object Generator p23, src/game/world/fx.ts). Before the booth statue (Relay 895b
  // destroys the gates).
  {
    id: '1a.metal-detector',
    obj: 'walk west through the metal detector gate: the alarm sounds',
    do: 'stroll',
    gait: 'walk',
    turn: 3.5,
    via: [[386, 88.7, 494.8], [378, 88.7, 494.8], [372, 88.7, 494.8]],
    settle: 1,
    expect: { heard: [[0x8147, '3:297']] },
  },
  { id: '1a.lobby-health', obj: 'Xombium bottles in the lobby', do: 'pick', uid: 0x77c7, optional: true },
  { id: '1a.statue', obj: 'push a lobby statue off its pillar ...', do: 'push', uid: 0x75d5, stand: [389.5, 88.66, 488.4], dir: [0, -1], secs: 2.5 },
  {
    id: '1a.statue-booth',
    obj: '... and east into the corridor: a CartWheeler bursts out of the booth',
    do: 'push',
    uid: 0x75d5,
    stand: [388.4, 88.66, 484.45],
    dir: [1, 0],
    secs: 5,
    then: { cine: true, fight: 40 },
    expect: { played: [0x5db4], destroyed: [0x512a] },
    shot: true,
  },
  // The sally port: its two gates take turns (the booth button swaps them); a statue left in a
  // gate's swing (pushable Detectors 8a47 / 7507) makes that gate bounce back open. Pull the
  // statue from the north gate's swing into the south gate's, then press the button.
  { id: '1a.gate-statue', obj: 'pull the statue into the south gate (jams it open)', do: 'push', uid: 0x8a46, stand: [384, 88.66, 474.3], dir: [0, 1], key: 'KeyS', secs: 5, until: `__world.world.get(0x7507).s.inside.size > 0` },
  { id: '1a.button', obj: 'in the booth: the sally port button (ambush)', do: 'use', uid: 0x7c69, stand: [388.4, 88.66, 475.3], then: { wait: 2, fight: 40 }, expect: { open: [0x4f0d, 0x4f0e] } },
  // (Detector 8396 is a 1 m slab across the corridor, z 446..447: the walk ends in its middle.
  // It used to end at 447.3, short of it, and Autosave 8397 came on the next step.)
  { id: '1a.cp3', obj: 'through the gate, north: third checkpoint (an insanity vision on the way)', do: 'walk', to: [384, 88.7, 446.5], tol: 0.3, then: { wait: 2 }, expect: { checkpoint: 0x8397 } },
  { id: '1a.gas', obj: 'the gas chamber: camera scene, CartWheelers', do: 'walk', to: [422.4, 88.7, 447], again: [417.5, 88.7, 447], then: { cine: true, fight: 30 }, expect: { played: [0x7abf] }, shot: true },
  // The trap as a player meets it: the tank door opens 39.5 s into the inmate's scene and the
  // gas lights the floor tiles from the tank door towards the window (5 s .. 15 s later, 13 / s
  // each to a body whose hit spheres reach into the tile). No tile covers the 1.1 m strip along
  // the north wall under the window, where the CartWheeler breaks in: wait there, then fight it
  // without stepping onto the gas while it is on (docs/game-logic.md §11.5 item 7, §14.2).
  {
    id: '1a.gas-trap',
    obj: 'trapped: wait out the gas under the window, where a CartWheeler smashes in',
    do: 'walk',
    to: [420.5, 88.66, 463.75],
    tol: 0.3,
    then: {
      until: `!!__world.world.get(0x6e67).s.played && !__world.world.runningStomps().some((r) => r.uid === 0x6e67)`,
      timeout: 90,
      fight: 40,
      stay: `__gas.onList().some((u) => u !== 0x5c31)`,
    },
    expect: { played: [0x71ea, 0x6e67] },
    shot: true,
  },
  { id: '1a.window', obj: 'out through the broken window', do: 'walk', to: [420.8, 88.66, 470] },
  { id: '1a.exit', obj: 'down to the basement: the door to 1b', do: 'use', uid: 0x79b2, then: { level: '1b PrisonDeathRow' }, expect: { level: '1b PrisonDeathRow', checkpoint: true }, shot: true },
  // ---- 1b ----
  // Horace (7eb2) is handed back by "Camera" #247 on a narrow beam in his electrified niche over
  // the arena and woken by its finish (DormantBehavior -> IdleBehavior): he stays up there
  // (bug 29: he dropped 6.6 m to the arena floor).
  { id: '1b.horace', obj: 'out of the arrival room: Hermes and Horace', do: 'walk', to: [462, 79.7, 470], then: { cine: true, wait: 4 }, expect: { played: [0x7f41], checkpoint: true, actorAt: [[0x7eb2, [459.74, 80.2, 493.15], 0.4]] }, shot: true },
  { id: '1b.save', obj: 'save / load round trip (start of 1b)', do: 'saveLoad', label: 'start-1b' },
  {
    // Hermes, Horace and Killjoy talk in turn; between their lines the cloners drop CartWheelers
    // from the wall holes; in the last wave the player is to go insane (Detector 7ed4 checks
    // the creature form); then 80a6 plays and unlocks the door 6a4a.
    id: '1b.arena',
    obj: 'the arena: CartWheeler waves, the first transformation',
    do: 'arena',
    // On the arena floor: creatures right under the walkway would "attack" from below (their start
    // test is horizontal only) and could not be reached.
    stand: [470, 73.7, 484],
    // The fight is kept to the arena (its wall holes and cloners are 6..13 m from the stand): the
    // ledge ambush's CartWheeler 6725, asleep at its placement (478.2, 73.7, 450.1) 35 m off, was
    // engaged and walked at two or three times a try, with no path within 15 m of it (runs b1,
    // h1, f1).
    hold: 18,
    preyR: 18,
    until: `!!__world.world.get(0x6a4a).s.unlocked`,
    timeout: 600,
    force: { why: 'arena not finished in time: relay 7ed2 sent (the end of sequence 80a6)', js: `__world.world.send(0x7ed2, 1, 0x80a6)` },
    loot: 14,
    expect: { played: [0x80a6] },
    shot: true,
  },
  // The Xombium bottles on the way are picked up (`loot`): the arena's 7fa3 / 7fa4 / 7fa5, 88e5
  // past its door, 700e / 700f by the ledges. From the deep link the player has none, and the
  // arena and the ledge ambush cost him 40..110 health (runs f1, e1..e4).
  { id: '1b.cp2', obj: 'through the arena door: checkpoint', do: 'goto', to: [448.5, 73.7, 476.3], loot: 14, expect: { checkpoint: 0x8339 } },
  { id: '1b.ledges', obj: 'up the ledges past the arena (clamber twice)', do: 'clamber', from: [473.3, 73.65, 428.4], preLoot: 16, face: [[471.75, 75, 428.4], [469, 79.5, 428.5]], stands: [null, [471.75, 76.23, 428.5]] },
  { id: '1b.cp3', obj: 'the checkpoint on the ledge', do: 'walk', to: [469, 79.7, 428.4], expect: { checkpoint: 0x833b }, shot: true },
  // Horace talks again on the way (Detector 88f4); the hall ends at a locked door with 30 health.
  { id: '1b.door', obj: 'smash the locked door at the end of the hall', do: 'break', from: [438.6, 79.65, 393.9], uids: [0x53c2], expect: { destroyed: [0x53c2] } },
  { id: '1b.vision', obj: 'the room behind it (a vision)', do: 'walk', to: [428.3, 79.7, 390.5], then: { wait: 3 } },
  // The door 653a stays locked while a pushable stands in Detector 7fe9 in front of it.
  // Out of the corridor (into the open end at z < 412) so that the player can get past it.
  { id: '1b.crate', obj: 'pull the crate away from the door', do: 'push', uid: 0x7fde, stand: [418.25, 79.65, 417.6], dir: [0, -1], key: 'KeyS', secs: 8, until: `!!__world.world.get(0x653a).s.unlocked && __pt.center(0x7fde)[2] < 411.5` },
  { id: '1b.ladder', obj: 'through that door and up the ladder', do: 'ladder', from: [413.5, 83.05, 395.3], face: [412.5, 84.5, 395.3], top: 88.4, shot: true },
  // The exit door stays locked: trying it (p69 Triggered) starts Timer 79c2 -> Level Transition 79c3.
  { id: '1b.exit', obj: 'the door to 1c', do: 'use', uid: 0x52b6, goto: [410.94, 88.68, 392.6], transition: 0x79c3, then: { level: '1c PrisonDeathRow' }, expect: { level: '1c PrisonDeathRow' }, shot: true },
  // ---- 1c ----
  { id: '1c.room', obj: 'into the guard room (the door locks behind)', do: 'walk', to: [439.5, 88.7, 401.7], then: { wait: 6 } },
  { id: '1c.map', obj: 'the North Yard map', do: 'pick', uid: 0x80ac, optional: true },
  {
    id: '1c.monitor',
    obj: 'smash the security monitor: the scene behind the glass, the door opens again',
    do: 'break',
    uids: [0x6d84],
    from: [429.6, 88.7, 404.2],
    then: { until: `!!__world.world.get(0x5250).s.unlocked && !__stomp.runs.length`, timeout: 90 },
    expect: { played: [0x7336] },
    shot: true,
  },
  {
    id: '1c.companion',
    obj: 'the inmate behind the bars talks, then comes out',
    do: 'walk',
    to: [434.6, 88.7, 387.2],
    then: { until: `!!__world.world.get(0x5262).s.open`, timeout: 60 },
    expect: { open: [0x5262] },
  },
  { id: '1c.cp1', obj: 'first 1c checkpoint (a Slayer)', do: 'goto', to: [435, 87.9, 380.1], then: { wait: 2, fight: 40 }, expect: { checkpoint: 0x8000 }, shot: true },
  { id: '1c.save', obj: 'save / load round trip (mid-1c)', do: 'saveLoad', label: 'mid-1c' },
  {
    // The inmate leads into the yard; at Waypoint 7581 (or Detector 7ded) CartWheeler 6520 jumps
    // down from the wall, the others follow when it or the Slayer dies (Relay 7ef7). Count Down
    // 7b95 (the three CartWheelers and Slayer 7def) then sends the inmate on.
    id: '1c.yard', diag: allyDiag(0x7569),
    obj: 'follow the inmate into the yard and clear it',
    do: 'follow',
    uid: 0x7569,
    fight: true,
    until: `(() => { const c = __world.world.get(0x7b95); return !c || c.destroyed || (c.s.count ?? 1) <= 0; })()`,
    timeout: 240,
  },
  { id: '1c.cp2', obj: 'second 1c checkpoint', do: 'goto', to: [465.6, 86.6, 433.8], then: { wait: 2 }, expect: { checkpoint: 0x7ffe } },
  // The east yard's last CartWheelers (7e16 / 7e1a / 7e20 / 7e21, hidden) come with Relay 8017:
  // the player crossing Detector 7e13 (x 486..513 at z 389.9) starts the cinematic 8014 and,
  // with the Slayers dead, Behavior Changers 7e17 / 7e1d / 7e23. The companion flees from the
  // creatures (FleeBehavior 7e3e) instead of leading the player there, so the player goes ahead.
  { id: '1c.east', obj: 'into the east yard (Detector 7e13: the last CartWheelers)', do: 'walk', to: [499, 78.1, 387.5], tol: 1, then: { wait: 2, fight: 40 } },
  {
    // On to the east yard: Count Down 7e2a (two Slayers, six CartWheelers) -> Relay 8080 gives
    // the inmate his last walk; his Waypoint 7b8c enables the transition 7813 (Relay 808c).
    id: '1c.lead', diag: allyDiag(0x7569),
    obj: 'follow the inmate to the yard gate (the second group)',
    do: 'follow',
    uid: 0x7569,
    fight: true,
    until: `!!__world.world.get(0x7813)?.enabled`,
    timeout: 300,
  },
  // The yard gate: up the ladder where the inmate stopped (Waypoint 7b8c), north along its
  // landing, down onto a crate and the ground behind the fence (door 7fe7 stays locked), up the
  // mound with a jump, along the walkway to the gate. The gate stays locked; trying it starts
  // Timer 7815 -> Level Transition 7813.
  { id: '1c.ladder', obj: 'up the ladder at the end of the inmate\'s walk', do: 'ladder', from: [528.4, 79.1, 399.24], face: [529.55, 81.5, 399.24], top: 84.5 },
  { id: '1c.drop', obj: 'along the landing and down behind the fence', do: 'route', pts: [[530.8, 84.7, 403.5], [530.8, 84.6, 406], [530.8, 81.5, 408], [530.5, 79.1, 411.5]] },
  { id: '1c.mound', obj: 'up the mound to the gate walkway', do: 'route', pts: [[523, 79.3, 412.5], [518.3, 82.4, 418.3], [518.6, 83.1, 418.9], [523, 83.8, 424.5]] },
  { id: '1c.exit', obj: 'the door to chapter 2 (Cellblocks)', do: 'use', uid: 0x57e9, goto: [531, 85.05, 432.5], transition: 0x7813, then: { level: '2 Cellblocks' }, expect: { level: '2 Cellblocks' }, shot: true },
  // ---- 2 Cellblocks (block owned by the chapter 2 route) ----
  // The inmate (Dallas, 868: the 1c inmate carried over, placed at Companion Spawn Point 1bf0)
  // talks (20:2, "take point") and follows the player (WaypointBehavior 86c -> FollowBehavior 902).
  { id: '2.arrive', obj: 'arrive from 1c: the inmate talks, then follows', do: 'wait', until: `__actors.manager.get(0x868)?.behavior?.kind === 'follow'`, timeout: 40, shot: true },
  // A barricade closes the corridor north: five junk Breakables count Count Down 18f6 down, which
  // unlocks (Enable -> p28 inUnlock) the bed 18f1 behind them; pushed out of Detector 32ae
  // (pushables) it opens the nav edge 18fc-18fb for the inmate (EdgeToggler 3087). Pushed on to
  // the far wall it leaves his way north (Move Nodes 18f9 -> 7e8 along x 137) clear.
  { id: '2.junk', obj: 'smash the junk on the barricade', do: 'break', from: [137.6, 103.7, 143.4], uids: [0x18f3, 0x18f4, 0x18ee, 0x18f2, 0x18f5, 0x18f7], expect: { destroyed: [0x18f6] } },
  { id: '2.bed', obj: 'push the bed north out of the corridor mouth, to the far wall', do: 'push', uid: 0x18f1, stand: [137.4, 103.66, 141.6], dir: [0, -1], secs: 14, until: `__pt.center(0x18f1)[2] < 131` },
  // Dallas walks into Detector 904 (NPCs): Instance Message Filter 905 passes him to Behavior
  // Changer 906 (talk 20:4, then WaypointBehavior 908).
  // He hangs back (FollowBehavior 902: runs once the way to the player is over 10 m, stops 7 m
  // short of where the player was): the player goes 4 m on past the junction so that his run
  // crosses Detector 904 (z 122.8..126.8).
  { id: '2.north', obj: 'north past the corridor junction; the inmate follows and talks', do: 'walk', to: [125, 103.7, 115], then: { until: `/ 906(;|$)/.test(__pt.msgs(4000))`, timeout: 30 } },
  // Through doors 818 / 843 to the walkway over the cell block: Detector 848 (or 3315 by the
  // stairs) plays "Mainliner" 847: a Mainliner drags a CartWheeler off the walkway; the inmate
  // walking into Detector 931 passes Instance Message Filter 932 (his line 20:5). The sequence
  // has the cinematic flag but no Camera track: it plays in the world while the player keeps
  // his view and control (World.takesCamera): he watches it from the walkway.
  { id: '2.mainliner', obj: 'east along the upper walkway: the Mainliner scene starts', do: 'walk', to: [148.7, 103.7, 112], then: { until: `!!__world.world.get(0x847)?.s.played`, timeout: 10 }, expect: { played: [0x847] } },
  { id: '2.mainliner-watch', obj: 'watch the Mainliner drag the CartWheeler off the walkway (view and control stay the player\'s)', do: 'look', at: [158, 104.8, 110], then: { until: `(() => { if (__world.world.activeCutscenes().length || !__player.enabled) window.__ptSceneTook = 1; return !window.__ptSceneTook && !__world.world.runningStomps().some((r) => r.uid === 0x847); })()`, timeout: 20 }, shot: true },
  // Down the stairs into the cell block: Count Down 3383 needs the player inside Detector 3382 and
  // the inmate at Waypoint 86a (he walks there once he steps into Detector 90c, Instance Message
  // Filter 90d -> Behavior Changer 90e; Waypoint 869 cancels the fallback Timer 12a3, which would
  // otherwise wake Mainliner 867 10 s after the player crosses Detector 1295). Then "Camera"
  // 1a61: Mainliner 867 leaps at the player (Relay 1296 -> MainlinerJumpAttackBehavior 870).
  { id: '2.hall', obj: 'down into the cell block with the inmate: the camera scene, a Mainliner leaps', do: 'walk', to: [166, 97.7, 112.5], then: { until: `!!__world.world.get(0x1a61)?.s.played`, timeout: 60 }, expect: { played: [0x1a61], checkpoint: 0x1c74 }, shot: true },
  // Mainliner 867 fights, then Object Cloner 91b sends its Mainliners (Timer 12a5); their end
  // (the cloner's p17 Triggered -> Relay 91d -> Timer 12a7) gives the inmate his next line and
  // FollowBehavior a5b.
  { id: '2.clones', obj: 'fight the Mainliners in the cell block', do: 'arena', stand: [166, 97.7, 112.5], until: `(() => { const r = __world.world.get(0x91d); return !!r && (r.destroyed || (r.s.left ?? 1) <= 0); })()`, timeout: 300, shot: true },
  // The cell block's switch 809 opens the scripted doors 84c (east), 3158 (south) and the cell
  // e3, and gives the inmate his line 20:119 (Relay 312c -> Behavior Changer 3129, then
  // FollowBehavior 312b).
  { id: '2.switch', obj: 'the cell block switch: the doors east and south open', do: 'use', uid: 0x809, then: { wait: 3 }, expect: { open: [0x809] } },
  // East through door 85c into the steam-pipe yard (door 3158 only opens a corridor of cells):
  // crossing Detector a63 starts its five vents (Switches 956 / 957 / 958 / 959 / 95b, not
  // usable): each steams and sends four Mainliners, one at a time (Object Cloners 2e95 / 2eaa /
  // 2ea3 / 2eb5 / 2e9c: p1 0 endless, p2 1 alive; each copy counts its Count Down of 4 down, whose
  // zero turns the vent off, Timer -> Test = the cloner's p12 Off). The player runs through to the
  // east wing; Detector 2f92 there takes checkpoint 334c (or 32ff checkpoint 3361 coming the other
  // way: the first destroys the other's relay). The inmate's type is barred from the yard door
  // (Move Node 9bd): he goes round by the cell e3 and the middle block.
  { id: '2.yard', obj: 'run through the steam-pipe yard into the east wing: checkpoint', do: 'walk', run: true, to: [257, 97.7, 152], then: { wait: 2, fight: 30 }, expect: { checkpoint: 0x334c }, loot: 10, shot: true },
  // The inmate's own way on runs through this yard too (the cell e3, then nodes 1ccd .. 9cd ..
  // 9ed: only the yard door 9bd is barred to his type), after the player. Left alone with the
  // vents' Mainliners (one copy alive per vent until its four are dead) he died there in every
  // run; the player goes back and clears the yard, as a player covering him would: each vent's
  // Count Down (2e92 / 2ea7 / 2ea0 / 2eb2 / 2e99, four copies each) at zero turns it off (Timer ->
  // Test = the cloner's p12 Off). Then he is led on to the east wing. (Waiting only until he had
  // come within 9 m ended at once when he was at the player's heels, and he died in the yard
  // behind the player to the copies and the steam.)
  {
    id: '2.cover',
    obj: 'back into the yard: clear the vents\' Mainliners for the inmate',
    diag: allyDiag(0x868),
    do: 'arena',
    stand: [222, 97.4, 118],
    // (The vents stand at x 264, 42 m east of the yard door: the whole yard.)
    hold: 45,
    until: `!__actors.manager.get(0x868)?.alive || [0x2e92, 0x2ea7, 0x2ea0, 0x2eb2, 0x2e99].every((u) => (__world.world.get(u)?.s.count ?? 0) <= 0)`,
    timeout: 420,
  },
  { id: '2.east', obj: 'on to the east wing with the inmate', do: 'walk', to: [257, 97.7, 152], then: { wait: 2, fight: 20 } },
  {
    id: '2.dallas', diag: allyDiag(0x868),
    obj: 'the inmate comes round by the middle block',
    do: 'wait',
    until: `(() => { const a = __actors.manager.get(0x868); return !a?.alive || Math.hypot(a.position.x - __player.position.x, a.position.z - __player.position.z) < 12; })()`,
    timeout: 150,
    expect: { actorAlive: [0x868] },
  },
  // The middle block: Detectors f9c / 1067 drop two CartWheelers off the ceiling (Relay 1064) by
  // three inmates (f7d / f7e / f7f, invulnerable until Detector 33e1 or the CartWheelers' end).
  { id: '2.middle', obj: 'west into the middle block: CartWheelers drop by three inmates', do: 'walk', to: [190, 97.1, 174], then: { wait: 3, fight: 30 } },
  // The inmate walking into Detector 2f90 passes Instance Message Filter f9e: he and the inmates
  // talk (Behavior Changers f89 / f8b / f8d / f91 ...), then they turn on him and the player
  // (KillEnemies f98 with p3 [868, player]) and he on them (f99).
  // (He stops 7 m short of where the player was: the player goes on west past Detector 2f90,
  // x 187..190, so that he runs into it.)
  { id: '2.talk', obj: 'lead the inmate to the three: they talk', do: 'walk', to: [181, 97.1, 174.5], then: { until: `/ 868 f9e(;|$)/.test(__pt.msgs(4000)) || !__actors.manager.get(0x868)?.alive`, timeout: 60 } },
  { id: '2.inmates', diag: allyDiag(0x868), obj: 'the three inmates turn on the player and the inmate', do: 'arena', stand: [190, 97.1, 180], until: `[0xf7d, 0xf7e, 0xf7f].every((u) => !__actors.manager.get(u)?.alive)`, timeout: 240, prey: [0xf7d, 0xf7e, 0xf7f], loot: 12, shot: true },
  // The east wing's walkway: a ladder (18cb) hangs from it 4 m above the floor. Breaking the
  // hidden Breakable 18ce at its foot (health 1) sends Relay 1a0d: Mechanism 18cc drops 4.2 m
  // (translation group) and Object Grouper 18cd takes the ladder down with it.
  { id: '2.catch', obj: 'knock the raised ladder down (the hidden catch 18ce at its foot)', do: 'break', from: [234.1, 97.1, 164.4], aim: [234.1, 100.2, 163.3], uids: [0x18ce], then: { wait: 3 }, expect: { destroyed: [0x18ce] } },
  { id: '2.ladder', obj: 'up the ladder to the walkway', do: 'ladder', from: [234.1, 97.1, 164.3], face: [234.1, 99.5, 163.3], top: 103.4, shot: true },
  // Detector 257a: Horace, in his electrified cage, talks (Behavior Changer 2572, p17 2 when the
  // talk ends = Off to the power Switch aee): the power goes (Screen Fader 2577, Relay 2579), the
  // inmate gets his line 20:202 and KillEnemies 312d on the catch 18ce.
  { id: '2.horace', obj: 'Horace in his cage on the walkway: he talks, the power is cut', do: 'walk', to: [232, 103.7, 158.5], then: { until: `/ 2 aee 2578(;|$)/.test(__pt.msgs(4000))`, timeout: 60 }, shot: true },
  { id: '2.upper', obj: 'south along the upper floor through door aed: checkpoint', do: 'walk', to: [254, 103.7, 208], then: { wait: 2, fight: 30 }, expect: { checkpoint: 0x1c75 }, loot: 8 },
  // Down into the south block: Detectors fd1 / 3357 play "Witness" (fd0), Detector 30cf "Hanging
  // Prisoner 01" (30cc).
  { id: '2.witness', obj: 'down into the south block: the Witness and Hanging Prisoner scenes', do: 'walk', to: [205, 94.7, 247], then: { wait: 3, fight: 30 }, expect: { played: [0xfd0, 0x30cc] } },
  // Detector fd2 -> Relay 30dd: "Camera" 2e01 (34 s); at its end six inmates (fdf / ff6 / fdd /
  // fde / fdc / 7f4, Count Down fe0) lose their invulnerability, the gunner 7f4 takes the mounted
  // gun 2dbf (RootPlayAnimBehavior 2e09); "Dallas" (2ebd) through Relay fd3.
  { id: '2.camera', obj: 'the south yard: the camera scene', do: 'walk', to: [194.6, 94.7, 251], then: { cine: true, wait: 2 }, expect: { played: [0x2e01] }, shot: true },
  // The gunner 7f4 shoots from his nest through its window. Count Down 2e11 counts his Damaged
  // (5): Relay 2e07 hands him WaypointBehavior 2e0b (out through the locked door be4, whose
  // Edge Passage 2e0f has p4 = 1: characters pass it locked), stops the alarm, switches the gun
  // off and wakes fdc (Behavior Changer 3419). The revolver in the yard (Ammo Box 160e) arms
  // the player for it.
  { id: '2.revolver', obj: 'take the revolver lying in the south yard', do: 'pick', uid: 0x160e, optional: true },
  {
    id: '2.gunner',
    obj: 'shoot the gunner at the window of his nest until he leaves the gun',
    do: 'shoot',
    uid: 0x7f4,
    // Single revolver shots: Count Down 2e11 counts five of his Damaged and sends him out through
    // be4. The Tommy Gun's bursts (fight weapon choice) killed him at his gun inside the nest
    // before he left, the nest door stayed locked, and the lever 1356 with it (run d2).
    weapon: '4:5',
    from: [171, 94.7, 251],
    until: `(() => { const c = __world.world.get(0x2e11), a = __actors.manager.get(0x7f4); return !c || c.destroyed || !a?.alive || Math.hypot(a.position.x - 163.7, a.position.z - 248.8) > 1.5; })()`,
    timeout: 90,
  },
  {
    id: '2.riot',
    obj: 'the six inmates of the south yard (Count Down fe0)',
    do: 'arena',
    stand: [185, 94.7, 245],
    until: `(() => { const c = __world.world.get(0xfe0); return !c || c.destroyed; })()`,
    timeout: 300,
    // (Not the gunner 7f4: he has to walk out of his nest alive, through its locked door be4,
    // which only his Edge Passage opens; the lever 1356 stands inside. Killed at his gun by the
    // riot's fights the nest stayed shut and so did the gate c36: runs d2 / f2.)
    prey: [0xfdf, 0xff6, 0xfdd, 0xfde, 0xfdc],
    spare: [0x7f4],
    // The yard and its upper floor only (creatures elsewhere in the block drew the run away).
    preyR: 30,
    force: { why: 'riot not over in time: the inmates left killed through services.actors.damage', js: `(() => { for (const u of [0xfdf, 0xff6, 0xfdd, 0xfde, 0xfdc]) { const a = __actors.manager.get(u); if (a?.alive) __actors.services.actors.damage(a, 1000, __player.position.clone(), 'player'); } return 1; })()` },
    shot: true,
  },
  // The gate c36 (locked, no Edge Passage) opens from the lever 1356 by the nest (p64 On, p65
  // Off). Count Down fe0 sends the inmate there (WaypointBehavior 314c -> Waypoint 314b -> Timer
  // 314e: On to the lever); the lever is the player's too (unlocked, usable), so with the inmate
  // dead or elsewhere the player pulls it himself.
  // (Once more when the first try did not open it: in run b2 the riot ended with the player
  // transformed, and the uses made while he changed back found no lever in view.)
  { id: '2.gate-try', obj: 'pull the lever by the nest', do: 'use', uid: 0x1356, unless: `!!__world.world.get(0xc36)?.s.open`, then: { wait: 3 } },
  { id: '2.gate', obj: 'pull the lever by the nest: the gate c36 opens', do: 'use', uid: 0x1356, unless: `!!__world.world.get(0xc36)?.s.open`, then: { wait: 3 }, expect: { open: [0xc36] } },
  // Beyond c36: the south-west pit (y 94.7) under the floor of the exit (y 100.7). Clamber
  // Point 3024 (template 2:641: p7 1 m) is a 2.1 m step on the wall under 80b, an 18 m wall
  // top; its anchor is the player's place along the edge (clamber.ts, 0x100114f0), 4.1 m up from
  // the step. The lever fed up there slides the double door 1b59 / 1b5a (Mechanisms) open for
  // 5.5 s for the inmate's last walk (Count Down ff0). The exit door c0c is locked: trying it
  // starts Timer 11ac -> Level Transition 11aa (3a, "NorthEast Spawn").
  { id: '2.climb', obj: 'out of the pit: the step 3024, then the wall top 80b', do: 'clamber', from: [129.5, 94.7, 237.6], face: [[129.5, 96.5, 235.9], [127.75, 101.5, 235.9]], stands: [null, [129.4, 96.78, 235.95]], shot: true },
  { id: '2.exit', obj: 'the locked door c0c to 3a YardCellBlock', do: 'use', uid: 0xc0c, goto: [109.5, 100.7, 226.5], transition: 0x11aa, then: { level: '3a YardCellBlock' }, expect: { level: '3a YardCellBlock' }, shot: true },
  // ---- end of 2 Cellblocks ----
  // ---- 3a / 3b YardCellBlock (block owned by the chapter 3 route) ----
  // First visit (docs/playthrough.md "Chapter 3"): 2 -> 3a NorthEast Spawn, west across the yards
  // to the cell-house door 16c1 (Timer 18dd -> Level Transition 18dc) -> 3b West Spawn; through
  // 3b's cell blocks and basement to its roof (Detector 19da -> 19db, mail 31:1) -> 3a East Spawn
  // on the walkway; west through the burnt walkway, the stair room and the west walkway, down
  // the manhole ladder into the west yard, whose gate the Slayer breaks once the pit is lit by
  // a searchlight, to the door 3633 (Timer 431d -> Level Transition 18e3) -> 4a Quarry.
  { id: '3a.arrive', obj: 'arrive from 2 at the NorthEast Spawn', do: 'wait', until: 'true', timeout: 5, expect: { level: '3a YardCellBlock' }, shot: true },
  // Down the stairs into the east yard: "Prisoner 1" (28d5, Detector 404b / Relay 343e) plays on the way.
  // The stairs from the arrival walkway first: planned straight to the yard, the walk could
  // step (or jump, when stuck) off the 10 m walkway (runs 1 and 4: 58 of 100 health gone).
  // By the stairs (a straight walk to the yard went off the walkway's edge: 58 hp in the fall).
  // The prisoners scene (28d5, "Prisoner 1") starts on the way down.
  { id: '3a.descend', obj: 'down the stairs from the arrival walkway: the prisoners scene', do: 'walk', to: [489.5, 98.6, 398.2], tol: 1, then: { cine: true }, expect: { played: [0x28d5] } },
  { id: '3a.yard', obj: 'down into the east yard', do: 'walk', to: [470, 97.7, 420], then: { wait: 2 }, shot: true },
  { id: '3a.cp1', obj: 'the yard checkpoint (Detector 32a9 across the yard at z 415.5)', do: 'walk', to: [457.5, 97.7, 413.5], expect: { checkpoint: 0x3184 } },
  // Detector acb wakes the Slayer a10 and the CartWheelers 701 / 3ac4 jump off the wall; the
  // tower guards (3c68 / 3c69, KillEnemies 3c90 / 3ece: the player's team is an enemy) shoot.
  { id: '3a.gate', obj: 'through the fence gate 3a9b: the yard fight', do: 'use', uid: 0x3a9b, then: { wait: 1, fight: 60 } },
  // Detector 432f takes the invulnerability off the fence boards 329c..329e; Count Down 3292
  // (CartWheeler copies of 6ff / 700 and the Slayer 8d0) sends the Slayer 296e to shoot the
  // boards (KillEnemies 3ba8, p3 targets): the "Fence" scene knocks the fence over.
  { id: '3a.fence', obj: 'the fenced yard: fight until the Slayer shoots the fence down', do: 'arena', stand: [414, 97.7, 428], until: `!!__world.world.get(0x32a0).s.played`, timeout: 360, expect: { played: [0x32a0] }, shot: true },
  { id: '3a.gaurd1', obj: 'west to the cell house: the guards scene ("Gaurd1")', do: 'walk', to: [362, 97.7, 404.4], then: { cine: true, wait: 2, fight: 30 }, expect: { played: [0x968] }, shot: true },
  { id: '3a.to-3b', obj: 'the cell-house door to 3b', do: 'use', uid: 0x16c1, goto: [370.2, 98.34, 397.4], transition: 0x18dc, then: { level: '3b YardCellBlock' }, expect: { level: '3b YardCellBlock' }, shot: true },
  // ---- 3b ----
  { id: '3b.arrive', obj: 'arrive from 3a at the West Spawn', do: 'wait', until: 'true', timeout: 5, expect: { level: '3b YardCellBlock' }, shot: true },
  // The guard booth's button 1f7c opens the barred door 1f7b south (and enables Detector ad1).
  { id: '3b.button', obj: 'the guard booth button: the barred door south opens', do: 'use', uid: 0x1f7c, then: { wait: 2 }, expect: { open: [0x1f7b] } },
  { id: '3b.cp1', obj: 'back north over Detector ad1 (enabled by the button): checkpoint', do: 'walk', to: [391.5, 98.2, 361], then: { wait: 1, fight: 30 }, expect: { checkpoint: 0x2d74 } },
  // Detector 260d starts the inmate 2c89's talk (SimpleConversation 2e34); the phone 2d15 by
  // him (Timer 2e3c) moves it on; his last line turns him into a Slayer ("Slayer 1" 2f4e) and
  // Timers 2dff / 2e00 bring the CartWheeler 2cc5 through the "Static Door" (2d03).
  { id: '3b.talk', obj: 'the inmate in the corridor talks', do: 'walk', to: [373.5, 98.2, 332.1], then: { wait: 3, fight: 20 } },
  { id: '3b.phone', obj: 'answer the phone: the inmate becomes a Slayer; the static door', do: 'use', uid: 0x2d15, then: { until: `!!__world.world.get(0x2d03).s.played`, timeout: 240, fight: 40 }, expect: { played: [0x2f4e, 0x2d03] }, shot: true },
  { id: '3b.cp2', obj: 'past the static door: checkpoint', do: 'walk', to: [368.3, 98.2, 304], then: { fight: 30 }, expect: { checkpoint: 0x2d75 } },
  { id: '3b.south', obj: 'into the south block (the doors shut behind)', do: 'walk', to: [391, 98.2, 298], then: { fight: 30 } },
  // The guard desk button 208d swaps the doors 1e0f / 5a0; the barricade 2f94 (13 health) blocks
  // the doorway behind 5a0.
  { id: '3b.desk', obj: 'the guard desk button opens the east door', do: 'use', uid: 0x208d, then: { wait: 2 }, expect: { open: [0x5a0] } },
  // Both crates: with 2f94 gone the barrel 2f93 lying on 2f92 / 2f95 still overhangs the gap at
  // head height (their collision boxes, docs/game-logic.md §14.10); breaking 2f95 brings 2f92 and
  // 2f93 down (its p21 message 11 to its links).
  { id: '3b.barricade', obj: 'smash the barricade in the doorway', do: 'break', from: [396.6, 98.16, 286.5], uids: [0x2f94, 0x2f95], expect: { destroyed: [0x2f94, 0x2f95] } },
  { id: '3b.cp3', obj: 'east into the cell block: checkpoint', do: 'walk', to: [404, 98.2, 285.4], then: { fight: 30 }, expect: { checkpoint: 0x2d77 } },
  // The lever 13d5 opens the eight cells; cell 1ee has a hole down to the basement.
  { id: '3b.cells', obj: 'the cell lever opens the cells', do: 'use', uid: 0x13d5, then: { wait: 3 }, expect: { open: [0x1ee] } },
  { id: '3b.hole-cell', obj: 'into cell 1ee', do: 'walk', to: [428.5, 98.16, 297.3], tol: 0.3 },
  // The rubble under the hole (Static Objects 2d56 / 2d57, model 23:703) collides as two boxes
  // 2.5 m high from z 304.5 (docs/game-logic.md §14.10): land south of them; off their top the
  // basement walk may drop 2.5 m.
  { id: '3b.hole', obj: 'drop through the hole in the cell floor', do: 'route', pts: [[428.5, 98.16, 300.5], [430, 96, 303.2], [430, 93.75, 303.4]] },
  { id: '3b.basement', obj: 'north through the basement to the button', do: 'walk', to: [404.23, 92.16, 324.78], tol: 0.3, drop: 2.5, then: { fight: 40 } },
  { id: '3b.basement-door', obj: 'the basement button opens the door north', do: 'use', uid: 0x2177, then: { wait: 2 }, expect: { open: [0x2175] } },
  { id: '3b.cp4', obj: 'down the basement: checkpoint (Detector 2d7b, 1 m deep at z 346.4)', do: 'walk', to: [435.5, 86.2, 347.3], then: { fight: 40 }, expect: { checkpoint: 0x2d7c } },
  { id: '3b.tunnel', obj: 'the tunnel north', do: 'walk', to: [409.4, 86.2, 367.6], tol: 0.3, then: { fight: 30 } },
  // Up the rock ledges to the north cell block (Clamber Points 2a00, 29fe, 2d55 / 267f).
  // Left of the ceiling box over the ledge's east half (29c0, 2.18 m above its top): the room test
  // sweeps the proxy up to 2.245 m (docs/game-logic.md §14.10), so the climb is from x < 409.
  { id: '3b.climb1', obj: 'climb the first ledge', do: 'clamber', from: [408.6, 86.2, 367.6], face: [[408.6, 88.5, 369]] },
  // Clamber Point 29fe (yaw 180, side 3: its 3 m edge runs along z, x 413.4..414.4, top 91.4,
  // facing west; clamber.ts): climbed from the foot west of it, facing east, onto the ledge's
  // floor (from x 413.6).
  { id: '3b.climb2', obj: 'climb the second ledge', do: 'clamber', from: [413, 88.87, 376.8], face: [[413.9, 90, 376.8]] },
  { id: '3b.climb3', obj: 'climb out into the north cell block', do: 'clamber', from: [424.87, 93.75, 370.13], face: [[422.7, 95.8, 372.3]] },
  // Upstairs; from the walkway onto the ledge 2bfd (p23 0, a Jump target) and the roof (1da5).
  // The planner smooths its path under the stairs (the autopilot reaches waypoints by x / z):
  // the flight is walked by hand, east along z 375.5, round at x 448, west to the top.
  { id: '3b.stairs-foot', obj: 'to the foot of the stairs', do: 'walk', to: [437, 98.16, 375.5], tol: 0.5, then: { fight: 30 } },
  { id: '3b.stairs', obj: 'up the stairs to the upper walkway', do: 'route', pts: [[438, 98.16, 375.5], [447, 101, 375.5], [448.3, 102, 373], [442, 103.5, 372.5], [440, 104.16, 370]] },
  { id: '3b.upper', obj: 'along the walkway to the cell 2b0 end', do: 'walk', to: [450, 104.16, 366.9], tol: 0.25 },
  { id: '3b.settle', obj: 'wait out any scene before climbing', do: 'wait', until: `__player.enabled && !__world.world.activeCutscenes().length && ![...document.querySelectorAll('.cutscene-layer')].some((e) => e.style.display !== 'none')`, timeout: 60 },
  // 2bfd (yaw 180, side 3) is a 1 m wide ledge along z (x 449.3..450.3) facing west; 1da5 (yaw
  // 158, side 3) faces west-south-west from the roof edge above it.
  { id: '3b.roof', obj: 'climb onto the roof', do: 'clamber', from: [448.6, 104.16, 368.9], face: [[449.8, 106.2, 368.9], [450.8, 110, 369.3]], stands: [null, [449.85, 106.47, 368.9]], nudge: true, settle: 1 },
  { id: '3b.exit', obj: 'across the roof: back to 3a (East Spawn)', do: 'walk', to: [456.7, 110.2, 382.7], then: { level: '3a YardCellBlock' }, expect: { level: '3a YardCellBlock' }, shot: true },
  // ---- 3a, back from 3b ----
  { id: '3a.return', obj: 'the walkway after 3b (mail 31:1: the burnt walkway)', do: 'wait', until: `!!__world.world.get(0x2149)?.destroyed || true`, timeout: 2 },
  { id: '3a.shotgun', obj: 'the shotgun on the walkway', do: 'pick', uid: 0x2192, optional: true },
  // The burnt gate 3ab0 (Switch, locked) collides as one 0.3 x 2.7 x 2 m box: its hole is drawn
  // only (docs/game-logic.md §14.10). The way on is the door ba2.
  { id: '3a.real-door', obj: 'through the door ba2 (Luthor walks off)', do: 'use', uid: 0xba2, goto: [393, 110.66, 390.6], then: { wait: 1 } },
  { id: '3a.stair-door', obj: 'the stair-room door 381f', do: 'use', uid: 0x381f, goto: [391, 110.66, 386], then: { wait: 1 } },
  { id: '3a.inner-stairs', obj: 'down the stairs', do: 'route', pts: [[389, 110.66, 381.5], [389.5, 110.66, 378.6], [391.5, 108, 378], [393.5, 106.8, 377]] },
  { id: '3a.cp2', obj: 'the room below: checkpoint', do: 'walk', to: [376, 104.66, 382], expect: { checkpoint: 0x3187 } },
  { id: '3a.walkway', obj: 'through door 3806 onto the west walkway (CartWheeler copies)', do: 'use', uid: 0x3806, then: { wait: 1 } },
  // Fights on the walkway hold the player's place (`stay`): the copies come up to him; chasing one
  // down the stairs at x 307 left him in the yard under the searchlights (run of 2026-10-14).
  { id: '3a.walkway-west', obj: 'west along the walkway', do: 'walk', to: [300, 106.66, 383], then: { fight: 40, stay: 'true' } },
  // The walkway searchlights cc2 / 348e (dark at start) on Detectors 13ed / 1b5b destroy the
  // Object Cloners 13c9 / 1b5a that keep sending CartWheelers along the walkway.
  { id: '3a.light-13ed', obj: 'searchlight cc2 on the walkway spawn spot (13ed)', do: 'searchlight', uid: 0xcc2, from: [320.6, 106.66, 387.1], at: [332.2, 108.2, 382.9], until: `(__world.world.get(0x13ed).s.fired ?? 0) > 0 || !!__world.world.get(0x13ed).destroyed` },
  { id: '3a.light-1b5b', obj: 'searchlight 348e on the far spawn spot (1b5b)', do: 'searchlight', uid: 0x348e, from: [316.3, 106.66, 387.1], at: [299.7, 108.1, 383.2], until: `(__world.world.get(0x1b5b).s.fired ?? 0) > 0 || !!__world.world.get(0x1b5b).destroyed`, then: { fight: 40, stay: 'true' } },
  // Searchlight cc3 (dark: p32 2): mounted, Fire lights it; its beam on Detector 13f8 lights the
  // pit's fires, stops the pit's Object Cloner 436d and counts Count Down 1b7a down.
  { id: '3a.searchlight', obj: 'the searchlight: light the pit', do: 'searchlight', uid: 0xcc3, from: [285.5, 106.66, 386.9], at: [291, 99.2, 402], until: `(__world.world.get(0x13f8).s.fired ?? 0) > 0`, shot: true },
  { id: '3a.manhole', obj: 'down the manhole ladder', do: 'ladderDown', uid: 0x157b, from: [288.4, 106.66, 383], face: [287.7, 104.5, 383], bottom: 98.2 },
  // The gas tanks 13c0.. in the store room: one breaks the rest (Relay 3e4e hides the door 3abb).
  // From the ladder's foot, where the ladder leaves him (walking about there faces the ladder
  // and remounts it).
  // The ladder 157b collides as its box (x 287.7..287.8, z 382.65..383.35; docs/game-logic.md
  // §14.10): the stand is on the side it leaves him, north of it.
  { id: '3a.tanks', obj: 'smash a gas tank: the store-room door is blown', do: 'break', from: [287.55, 97.66, 384.1], uids: [0x13c3], then: { wait: 2 }, expect: { destroyed: [0x13c3] } },
  { id: '3a.store-out', obj: 'out of the store room past the blown tanks, south into the west yard', do: 'route', pts: [[288.6, 97.66, 384.6], [287, 97.66, 388], [287, 97.66, 391]] },
  // Detector 3eec (a vision) starts the pit CartWheelers and Count Down 4372; the wall
  // CartWheelers, Object Cloner 4366 and the "Slayer" scene (42c7) that breaks the gate 3aa4.
  { id: '3a.west-yard', obj: 'the west yard: fight until the Slayer breaks the gate', do: 'arena', stand: [306, 97.7, 412], preyDy: 4, preyR: 20, hold: 14, until: `!!__world.world.get(0x3aa4)?.destroyed`, timeout: 420, expect: { played: [0x42c7] }, shot: true },
  { id: '3a.cp3', obj: 'through the gate: checkpoint', do: 'walk', to: [314, 97.7, 433], expect: { checkpoint: 0x318a } },
  // The exit door 3633 is on the porch of the strip behind the rail fences (x 308 / z 431: boxes
  // 0.4 x 4.3 m in the original's collision record, rails here). The way in is over the roofs:
  // the guard shack (door 3595) and its ladder 1593 up through the roof hatch (still there in
  // chapter 3: Relay 2424 only fires from mail 31:0 or Detector 1dff), a running jump west off the
  // shack roof (104) over the fence onto the exit building's awning (103), down off its south
  // edge (5.6 m, below the 6.5 m of fall damage) and back under it to the porch.
  { id: '3a.shack', obj: 'into the guard shack (door 3595) to its ladder', do: 'walk', to: [315.9, 97.7, 447.9], tol: 0.4 },
  { id: '3a.shack-ladder', obj: 'up the shack ladder 1593 through the roof hatch', do: 'ladder', from: [315.9, 97.7, 447.9], face: [315.08, 100.2, 447.9], top: 104 },
  { id: '3a.roof-leap', obj: 'a running jump off the shack roof onto the exit building awning', do: 'route', pts: [[314.3, 104.4, 448.6], [312.4, 104.4, 448.6], [305.5, 103.3, 448.6]], jumpAt: [312.4, 448.6, 0.5], timeout: 12 },
  { id: '3a.awning-drop', obj: 'off the awning down into the strip', do: 'route', pts: [[302.5, 103.3, 441.5], [302.5, 97.7, 437.8]], timeout: 12 },
  { id: '3a.exit', obj: 'the door to 4a Quarry', do: 'use', uid: 0x3633, transition: 0x18e3, then: { level: '4a Quarry' }, expect: { level: '4a Quarry' }, shot: true },
  // ---- end of 3a / 3b YardCellBlock ----
  // ---- 4a / 4b Quarry (block owned by the chapter 4 route) ----
  // 4a Quarry East, arriving from 3a in the mine building's east end (SouthWest Spawn 6888, by the
  // locked door 8485 back to 3a). Read from the level's message graph and checked in the browser
  // (docs/playthrough.md "4 Quarry"): Detector 82d9 by the arrival wakes the Nooseman 8439 and
  // Object Cloner 82d7 (four wall CartWheelers 82cf..82d5, then Cloner 84c9: three Mainliners).
  // Up the ladder 8273 to the upper floor, whose way north is blocked by stacked crates (7:2008
  // Breakables 851e, 8520 + 851f, 8522 + 8521: the lower one breaking blows the upper) in front of
  // the door 827b; through it onto a ledge over the yard, and down (Detector 8495 shuts and locks
  // the door behind: Relay 84ae -> Timer 84ac).
  { id: '4a.arrive', obj: 'arrive from 3a at the SouthWest Spawn', do: 'wait', until: 'true', timeout: 5, expect: { level: '4a Quarry' }, shot: true },
  { id: '4a.wake', obj: 'west through the arrival room (Detector 82d9: the Nooseman and the wall CartWheelers)', do: 'walk', to: [712, 103.7, 619.5], then: { wait: 2, fight: 60 } },
  // The wall CartWheelers of Cloner 82d7 (82cf.. on the wall over the upper floor, 111.9) drop
  // onto the upper floor. A fight at the top of the ladder holds the player's place (`stay`): a
  // chase on that narrow floor took him over its edge, back down into the arrival room.
  { id: '4a.ladder', obj: 'up the ladder 8273 to the upper floor', do: 'ladder', from: [707.1, 103.7, 614.4], face: [707.1, 105.5, 613.3], top: 106, then: { fight: 30, stay: 'true' } },
  { id: '4a.crates', obj: 'smash the crates stacked in front of the door 827b', do: 'break', from: [699, 107.66, 625], uids: [0x851e, 0x8520, 0x8522], expect: { destroyed: [0x851e, 0x851f, 0x8520, 0x8521, 0x8522] } },
  { id: '4a.door', obj: 'through the door 827b onto the ledge over the yard', do: 'use', uid: 0x827b, then: { wait: 1 } },
  // Off the ledge's end (z 636, 107.6) into the yard 4 m down: the planner finds no free landing
  // cell at the wall's foot (z 636.5) since objects collide as their collision trees, so the
  // last metre is a hand-laid drop (checked in a session: lands at 103.7, no damage).
  { id: '4a.ledge', obj: 'along the ledge over the yard to its end', do: 'walk', to: [698.6, 107.66, 635.5], tol: 0.4 },
  { id: '4a.yard', obj: 'down into the yard (Detector 8495 shuts the door behind)', do: 'route', pts: [[698.6, 107.66, 636.2], [698.6, 103.7, 640]], timeout: 10, shot: true },
  // The vision by the fence (Detector 790f / 8203 or a look from 8204 through Visiblity Message
  // Filter 799c -> Relay 7904): the hanged men 78ed..78ef and the Screen Blur; it ends at Detector
  // 7910 or a look from 7d55 (filter 7d54) -> Relay 79a4 -> Screen Fader 79a6.
  { id: '4a.vision', obj: 'north along the fence: the vision of the hanged men', do: 'walk', to: [683.4, 104, 691.9], then: { wait: 3 } },
  { id: '4a.vision-end', obj: 'up to the gallows: the vision ends', do: 'walk', to: [677, 105, 714], then: { wait: 4, fight: 20 }, shot: true },
  // Three chained inmates (5b22..5b24) talk (Behavior Changers 65c9 ..); Detectors 65dd / 65de /
  // 65f4 (or hitting them) -> Relay 65df: they turn on the player (Timer 65e1) and Timers 65ff /
  // 6600 drop the CartWheelers 5b28 / 5b29, 5b25 / 5b26 off the rocks.
  { id: '4a.inmates', obj: 'west to the chained inmates: they turn on the player, CartWheelers drop', do: 'walk', to: [641, 104.5, 672], then: { wait: 3, fight: 60 } },
  { id: '4a.burrower', obj: 'on west past the Burrower (Detector 6b77)', do: 'walk', to: [597, 103.4, 690], then: { fight: 40 } },
  { id: '4a.cp1', obj: 'checkpoint (Detector 8527)', do: 'walk', to: [575.3, 103.7, 700.7], expect: { checkpoint: 0x77dd } },
  // Detector 75d6 -> Relay 79c2: the Infernas 75c2 / 75c4 run off along their waypoints (each
  // destroyed at its last one, p0 = 12) with their lines (Speech Players 79c4 / 79ce).
  { id: '4a.infernas', obj: 'west: two Infernas run off', do: 'walk', to: [556, 103.7, 712], then: { wait: 6 }, shot: true },
  // Detectors 5bad / 7715 -> Relay 5b9a -> Timers 5ba4..5ba6: the Slayers 5976..5978.
  { id: '4a.slayers', obj: 'on west: the Slayers', do: 'walk', to: [520, 103.7, 712], then: { wait: 2, fight: 60 } },
  { id: '4a.inferna', obj: 'Detector 79c3: the Inferna 7996 runs off', do: 'walk', to: [503, 103.7, 707], then: { wait: 4, fight: 20 } },
  // The pit under the crane 7c6e (its "Crane" sequence 21:23 plays from the start, Timer 7c66).
  // Detectors 7abc / 7ad6 wake the Burrower 7ac2; Detector 7a6c in the pit starts Object Cloner
  // 7ab4 (four Mainliners, two at a time); their deaths count Count Down 7f76 down (Cloners 7f74 /
  // 7f78: CartWheelers) and the eight deaths of Count Down 7f8c destroy the Burrower.
  // The fight at the edge holds the player's place (`stay`): one that chased down onto the rock
  // steps left him at (492.0, 97.9, 668.6), and from there the hand-laid way down slid him into a
  // gap between the rocks at (492.5, 96.4, 668.2) he could not jump out of (reproduced 1 of 3
  // starts; from the edge it went down every time).
  // (The rim above the rock steps, 104.2: the planner stops there, 0.7 m short of the first step
  // 5 m down; `4a.pit` takes the steps from the rim. The old point on the first step read as a
  // miss in every run, "0.9 / 1.2 / 1.4 m short".)
  { id: '4a.pit-edge', obj: 'to the pit under the crane', do: 'walk', to: [492.1, 104.2, 669.6], tol: 1.0, then: { fight: 20, stay: 'true' } },
  { id: '4a.pit', obj: 'down the rock steps into the pit (Detector 7a6c: the Mainliners)', do: 'route', pts: [[491.5, 98.2, 668.2], [491.1, 93.4, 667.8], [490.7, 89.9, 667.0], [490.3, 89.6, 665], [487.1, 90, 662.6], [487.1, 89.7, 658.6], [487.9, 89.1, 651.4], [487.5, 86.1, 651], [480, 86, 657]] },
  // Over when the Mainliners are dead (Count Down 7f76 spent: the CartWheeler cloners ran) and
  // nothing but the Burrower hunts in the pit: the level destroys it when the player leaves
  // (Timer 7ae4 after 120 s, Detector 7bd6 in the west tunnel -> Relay 7ae6), so it need not die.
  // The way down is hand-laid (the planner's drops ended once on a tree trunk at the rim); the
  // fight keeps to the pit floor (`hold`): the cloners' niches in its south-west corner trap a
  // player who walks in.
  { id: '4a.pit-fight', obj: 'the pit fight: Mainliners, then CartWheelers', do: 'arena', stand: [478, 85.8, 660], preyDy: 3, preyR: 10, hold: 9, until: `(() => !!__world.world.get(0x7f76)?.destroyed && !__pt.hostiles(30).some((h) => h.uid !== 0x7ac2))()`, timeout: 300, shot: true },
  { id: '4a.ladder2', obj: 'up the ladder 7aea into the west tunnel', do: 'ladder', from: [470.0, 85.9, 656.4], face: [469, 88, 656.4], top: 89.5 },
  { id: '4a.cp2', obj: 'the tunnel: checkpoint (Detector 84a0 -> Timer 8528 -> Autosave 77de)', do: 'walk', to: [458.5, 90.1, 664], expect: { checkpoint: 0x77de } },
  { id: '4a.tunnel', obj: 'west along the tunnel (Detector 5b79: CartWheelers 5974 / 5975)', do: 'walk', to: [432, 90, 685], then: { wait: 2, fight: 40 } },
  // The guard 5b7b in the cave: Detector 64cd -> his RootPlayAnim, 7c11 / 6609 his talks; the
  // player in Detector 660a within Timer 660b's 10 s plays "Guard" 64cb, else 660c: either one
  // ends with his DeathBehavior 81fa, +10 reputation (81dd / 81dc) and the Burrower 64ce (Relay
  // 6612). Hurting him instead: Relay 6613 / Timer 852b (-reputation, Screen Fader 852a).
  { id: '4a.guard', obj: 'into the cave: the guard\'s scene', do: 'walk', to: [391, 85, 678], then: { cine: true, wait: 2 }, expect: { played: [0x64cb] }, shot: true },
  { id: '4a.cave', obj: 'the cave: the Burrower 64ce', do: 'walk', to: [380, 84.8, 668], then: { fight: 40 } },
  // Out of the cave: Clamber Point 8190 (template 2:454, p30 2:455: side -local z, which the
  // placement turns to face +x; 2.5 m minimum height) from its east side.
  { id: '4a.climb', obj: 'climb out of the cave', do: 'clamber', from: [377.8, 84.8, 663.4], face: [[376.1, 88.5, 663.4]] },
  // Detector 8021 blows the Breakable 78ad (Relay 79cc) with the generators of 79cb; Detector 8014
  // -> Relay 8013: the Inferna 7a00 runs off south towards 4b (Waypoint 7a01).
  { id: '4a.blast', obj: 'up the rocks (Detector 8021: the blast)', do: 'walk', to: [384, 92, 657], then: { wait: 3, fight: 20 } },
  { id: '4a.inferna-exit', obj: 'the Inferna 7a00 runs off ahead', do: 'walk', to: [375.6, 96.1, 649.5], then: { wait: 3 }, shot: true },
  { id: '4a.exit', obj: 'south along the path: Detector 6caf -> Level Transition 6cb1 to 4b', do: 'walk', to: [371.5, 95, 635.5], then: { level: '4b Quarry' }, expect: { level: '4b Quarry' }, shot: true },
  // 4b Quarry West, arriving from 4a at the ravine's east end (Player Spawn Point 6888 from 4a).
  { id: '4b.arrive', obj: 'arrive from 4a', do: 'wait', until: 'true', timeout: 5, expect: { level: '4b Quarry' }, shot: true },
  // Detector 636b: the Burrowers 7fcd / 636a (Timers 83e3 / 83e4) and Object Cloner 8384's CartWheelers.
  { id: '4b.ravine', obj: 'west along the ravine: Burrowers and CartWheelers', do: 'walk', to: [330, 88.9, 692], then: { wait: 2, fight: 40 } },
  { id: '4b.west', obj: 'on west past the Infernas', do: 'walk', to: [300, 88.8, 690], then: { wait: 2, fight: 40 } },
  // Detectors 628d / 7d94: Object Cloner 67f5's Mainliners; 5b80: the Nooseman 7f94.
  { id: '4b.lever-area', obj: 'to the lever at the ravine head (Mainliners, the Nooseman)', do: 'walk', to: [285.2, 88.9, 662.5], tol: 0.8, then: { wait: 2, fight: 60 } },
  // The lever 7d7c starts locked; its lock (Breakable 7efe) sends Unlock when broken. Pulled, it
  // blows the rocks 7d90 / 7d8c / 7d8e off the ledge (Relay 7eff) and plays "Boulder" 7efd.
  { id: '4b.lock', obj: 'smash the lever\'s lock', do: 'break', from: [285.2, 88.9, 662.5], uids: [0x7efe], expect: { destroyed: [0x7efe] } },
  { id: '4b.lever', obj: 'pull the lever: the rocks on the ledge are blown away', do: 'use', uid: 0x7d7c, then: { wait: 4, fight: 20 }, expect: { destroyed: [0x7d90, 0x7d8c, 0x7d8e] }, shot: true },
  // Up the rock face: Clamber Points 7d71 (template 2:454 / p30 2:455), 6aaa, 7f00.
  // The foot is a sloping rock: Clamber Point 7d71's template 2:455 allows at most p2 = 4.5 m from
  // the feet up to the ledge top (95.25), so the feet must be at 90.75 or higher. The old stand
  // (266.6, 646.1) left them at 90.70..90.83 by where the walk stopped, and the clamber did not
  // start in about half the runs; the stand is now the rock's flat top (90.84).
  { id: '4b.climb1', obj: 'climb the first ledge', do: 'clamber', from: [267.0, 90.85, 645.9], tol: 0.15, face: [[264.8, 95.5, 645.9]] },
  { id: '4b.climb2', obj: 'climb the second ledge', do: 'clamber', from: [260.6, 95.2, 639], face: [[258.5, 99.5, 638.9]] },
  { id: '4b.climb3', obj: 'climb onto the upper path', do: 'clamber', from: [257.7, 99.1, 639.6], face: [[255.8, 101.5, 639.7]] },
  { id: '4b.cp1', obj: 'the upper path: checkpoint (Detector 8462)', do: 'walk', to: [296, 101.1, 640], expect: { checkpoint: 0x8461 } },
  // Detector 6da5: Object Cloner 84ed's Slayers and Relay 84eb, which takes the invulnerability off
  // the crate stack 8504.. (Count Down 7fcc: three broken -> Slayer 84f8, Cloner 84fd).
  { id: '4b.slayers', obj: 'south: the Slayers', do: 'walk', to: [300, 100.7, 620], then: { wait: 3, fight: 90 } },
  { id: '4b.crates', obj: 'smash the crate stack in the passage south', do: 'break', from: [319.3, 100.64, 603.9], uids: [0x8504, 0x8505, 0x850b, 0x8506, 0x850c], then: { fight: 40 } },
  { id: '4b.south', obj: 'south along the path', do: 'walk', to: [300, 101, 585], then: { fight: 30 } },
  { id: '4b.infernas', obj: 'south (Detector 7d1e: the Infernas 7b6a / 7b6b; Level Transition Remover 82ef)', do: 'walk', to: [296.5, 101.6, 551], then: { wait: 2, fight: 40 } },
  { id: '4b.cp2', obj: 'east: checkpoint (Detector 8379)', do: 'walk', to: [327.7, 106, 531.9], expect: { checkpoint: 0x6da2 } },
  // The gate east is held by two locks (Breakables 82c1 / 83e6).
  { id: '4b.gate', obj: 'smash the gate\'s locks', do: 'break', from: [333.3, 106.1, 533.5], uids: [0x82c1, 0x83e6], expect: { destroyed: [0x82c1, 0x83e6] } },
  // Detector 64dd: Object Cloner 64dc's CartWheelers in the pit below, where three inmates
  // (6825 / 6826 / 6ae7) are trapped; the pit's east part lies beyond a ditch.
  // The crane controls' platform (101.1) is walled off from the upper path (the level's
  // collision, a wall at x 353.8 from 105 up) and stands 1.7 m over the floor east of it (99.4):
  // down there by the east (drop), then a first-person jump onto it (2.05 m, Player p215 / p214),
  // as a player does. Checked in a session.
  // (From the gate's stand the path east past the wall's end drops straight onto the platform:
  // run e4 came there at 354.6 / 526, where the planner has no way down to the floor, and the
  // route below took it.)
  { id: '4b.controls-floor', obj: 'down to the floor east of the crane controls', do: 'walk', to: [364.6, 99.4, 525.7], tol: 0.5, drop: 5.5, unless: `__player.position.x > 354 && __player.position.y > 104` },
  { id: '4b.controls', obj: 'jump up onto the crane controls\' platform over the pit', do: 'route', pts: [[362.4, 101.1, 525.5], [360.2, 101.1, 522.7]], jumpAt: [364.2, 525.6, 0.6], timeout: 10, then: { fight: 20 } },
  // The crane controls 7bd9 (Mountable p30 = Crane 7a26): swung over Detector 7da5 (filter 5,
  // the crane's hung boulder) the "Boulder" 7ef0 drops.
  { id: '4b.boulder', obj: 'swing the crane: its boulder over the pit', do: 'crane', uid: 0x7bd9, from: [360.2, 101.1, 522.7], phases: [{ look: [-0.03, 0], until: `!!__world.world.get(0x7ef0).s.played`, max: 8 }], then: { wait: 3 }, expect: { played: [0x7ef0] }, shot: true },
  // "Boulder" ends with the boulder (Static Object 7d9f, Visibility Toggler 7da3) in the ditch
  // that cut the pit's east part off; Relay 7e8d drops the invisible wall 7e8a and the push-back
  // Detector 7e8b over it, Relay 7dc7 stops the CartWheeler cloner 64dc.
  // (Across the boulder the walk ends at its east end, 382 / 510.5: the clamber out takes it from
  // there. The old point 8 m on was a miss in every run since the collision trees.)
  { id: '4b.cross', obj: 'down into the pit and across the boulder', do: 'walk', to: [382, 96.1, 510.6], tol: 1.5, drop: 5.5, then: { fight: 30 } },
  { id: '4b.climb-out', obj: 'climb out of the pit (Clamber Point 74f3)', do: 'clamber', from: [391.2, 95.2, 505.4], face: [[392.2, 99.6, 504.4]] },
  // South off the ledge: the detonator 7507 (Relay 7b96: "EXPL1" 7bdc, Relay 7b98 blows the
  // Breakables 6885.. that close the way east, Relay 637d enables the checkpoint's Detector 6389).
  { id: '4b.ledge-drop', obj: 'south off the ledge to the quarry floor', do: 'walk', to: [415, 95.1, 461.3], drop: 5, then: { fight: 20 } },
  { id: '4b.detonator', obj: 'the detonator: the way east is blown open', do: 'use', uid: 0x7507, then: { wait: 6, fight: 20 }, expect: { played: [0x7bdc], destroyed: [0x6886] }, shot: true },
  { id: '4b.cp3', obj: 'east: checkpoint (Detector 6389)', do: 'walk', to: [435.6, 95.5, 468.5], expect: { checkpoint: 0x6f60 } },
  { id: '4b.east', obj: 'north-east along the quarry floor', do: 'walk', to: [452.2, 95.5, 492.2], then: { fight: 30 } },
  // Detectors 6c72 / 7d5a look through Visiblity Message Filter 6f8a at the hanged inmates.
  { id: '4b.vision', obj: 'up the slope: the hanged inmates', do: 'walk', to: [454.2, 97.6, 505.4], then: { wait: 3, fight: 40 } },
  { id: '4b.ridge', obj: 'up onto the ridge (Detector 81e0: the Burrower 64ca)', do: 'walk', to: [459, 103.6, 524.6], then: { fight: 40 } },
  { id: '4b.ridge-west', obj: 'west along the ridge', do: 'walk', to: [445, 105.5, 515.8], tol: 1.5, then: { fight: 30 } },
  { id: '4b.platform', obj: 'south to the crane platform (Detector 82ec: Pedro talks)', do: 'walk', to: [419, 105.1, 474.6], then: { wait: 2, fight: 30 } },
  // Pedro (74ff) is trapped across the broken plank bridge (he calls out to the player). The crane
  // controls 7c1d drive Crane 7a2f; its boulder lowered (look down) and swung into Detector 7e6e
  // (filter 5, enabled until Pedro dies: Relay 7f12) plays "Pedro" 7e6d: he walks off, +15
  // reputation (Reputation Points Sender 7f10).
  { id: '4b.pedro', obj: 'the crane: free Pedro', do: 'crane', uid: 0x7c1d, from: [412, 105.07, 473.9], phases: [{ look: [0, -0.03], max: 2 }, { look: [0.03, 0], until: `!!__world.world.get(0x7e6d).s.played`, max: 10 }], then: { wait: 6 }, expect: { played: [0x7e6d] }, shot: true },
  // The ending platform (x 378..394, y 105: Detector 682d, the crane controls 7c2f, the way to the
  // exit) is reached over the gap from the crane platform on Crane 7a2f's pallet (the "Crane
  // Palette" 23:856, which collides: docs/levels.md §4.6). Lowered to p29 = 4.1 m its top is at
  // the platforms' height (105.1 to 105.3); swung to the slew's end (-35 deg, Mountable p38) it
  // hangs 1.9 m off the ending platform's edge. A running jump (4.7 m) from the crane platform's
  // lip (the player clip 8463 rises to 105.9 at the edge) lands on it, a second one on the ending
  // platform.
  { id: '4b.bridge', obj: 'the crane: the pallet lowered and swung into the gap', do: 'crane', uid: 0x7c1d, from: [412, 105.07, 473.9], phases: [{ look: [0, -0.03], until: `__levels.skinnedProps.cranes.get(0x7a2f).hoist.cable >= 4.09`, max: 3 }, { look: [-0.03, 0], until: `__levels.skinnedProps.cranes.get(0x7a2f).slew <= -0.605`, max: 10 }], shot: true },
  { id: '4b.gap-edge', obj: 'to the crane platform\'s west edge', do: 'walk', to: [409.8, 105.1, 469.9], tol: 0.3, shot: true },
  { id: '4b.ending-platform', obj: 'jump onto the pallet and on to the ending platform', do: 'route', pts: [[406.5, 105.4, 468.9], [399.5, 105.1, 465.8], [389, 105.1, 462.5]], jumpAt: [[406, 468.75, 0.4], [397.9, 465.3, 0.4]], timeout: 12, shot: true },
  // Detector 682d -> Relay 82ff -> Reputation Points Message Filters 8300 / 8301 / 8302: one of
  // the "Camera" sequences 8303 / 78b9 / 8304 by reputation; each ends in Relay 8305 (the
  // Infernas 7877 / 7879 destroyed, Relay 82fc -> Breakable 78ad: the water tower falls).
  // (Onto the middle of Detector 682d, a 1 m slab: the walk used to stop 0.9 m short of it and
  // the scene came on the next step.)
  { id: '4b.ending', obj: 'the reputation scene', do: 'walk', to: [385, 105.1, 456.3], tol: 0.3, then: { until: `[0x8303, 0x78b9, 0x8304].some((u) => !!__world.world.get(u).s.played)`, timeout: 30, cine: true, wait: 4 }, shot: true },
  // Relay 8305 -> Relay 82fc takes the invulnerability off the water tower's base 78ad (1 health):
  // shot, it plays "WaterTower" 7869 (Relay 7875) and the tower comes down.
  { id: '4b.tower', obj: 'shoot the water tower\'s base: the tower falls', do: 'break', from: [372, 100.7, 441], uids: [0x78ad], then: { wait: 5 }, expect: { played: [0x7869] }, shot: true },
  { id: '4b.exit', obj: 'south to the exit: Detector 78b3 -> Level Transition 78b5 to 5a Asylum', do: 'walk', to: [388.6, 101, 404.4], then: { level: '5a Asylum' }, expect: { level: '5a Asylum' }, shot: true },
  // ---- end of 4a / 4b Quarry ----
  // ---- 5a / 5b Asylum (block owned by the chapter 5 route) ----
  // 5a Asylum Backyard (first visit): 4b -> East Spawn (522, 81, 496) at the foot of the hill; north
  // over the garden wall, past the gazebo (Carmen's vision) into the asylum's front courtyard, to the
  // locked front door ed9, whose use (p68 On / p69 Triggered) starts Timer 1a85 / Relay 2345 ->
  // Level Transition 167f -> 5b "North Spawn". No Autosave in 5a: the arrival checkpoint is the
  // transition's. Optional on the way: the west lawn (Detector 233f: the Phone 233c rings; Burrower
  // 17cf by Detector 17d0).
  { id: '5a.arrive', obj: 'arrive from 4b at the East Spawn', do: 'wait', until: 'true', timeout: 5, expect: { level: '5a Asylum' }, shot: true },
  // The path north: Detector 2320 plays the Movie Player 2322 (28:1, a flashback) on the way.
  { id: '5a.rubble', obj: 'north to the rubble heaped against the garden wall', do: 'walk', to: [519.97, 88.8, 402.44], tol: 0.3 },
  // The wall (top 94.6) is climbed by its rubble: Clamber Point 209c (template 2:641, p7 1 m: a
  // 2.4 m step), then 203c on the wall top (2:456). Both are modelless markers placed at 19 / 110
  // degrees: their boxes turn with the placement (interact.ts clamberMatrix).
  { id: '5a.wall', obj: 'up the rubble onto the garden wall (Clamber Points 209c, 203c)', do: 'clamber', from: [519.97, 88.8, 402.44], face: [[521.18, 91.6, 402.02], [521.47, 95, 400.82]] },
  { id: '5a.drop', obj: 'down off the wall into the garden', do: 'route', pts: [[521.5, 94.5, 399.5], [521, 89.5, 395]] },
  // The gazebo: Detectors 1df5 / 1df8 / 1df9 (Relay 1df7: the blur 1df6 and the vision sound
  // 1e12) and the garden-wide 1dfa count Count Down 1dfb down; at zero Behavior Changers 1ded ->
  // 1def -> 1df1 (Timers 1dfc / 1dfd between) give Carmen (1dea) her four lines (28:94 .. 28:97),
  // the last one enabling Detector 22d7 (her Visiblity Message Filter 22d8) and starting Timer
  // 1e18: 20 s to walk up to her.
  { id: '5a.vision', obj: 'the gazebo: Carmen\'s vision and her lines', do: 'walk', to: [461.7, 88.3, 373], tol: 1, then: { until: `__world.world.get(0x22d7).enabled || !__actors.manager.get(0x1dea)`, timeout: 90 }, shot: true },
  // Walking up to her (Detector 1dfe, or looking at her from 22d7) -> Relay 1dff -> Screen Fader
  // 1e01 -> Behavior Changer 1df3 -> Relay 1e06: the vision is gone (Relay 1e07) and two Burrowers
  // (1e1c / 1e1e) come for the player. Left alone, Timer 1e18 ends it without them (Relay 1e19).
  { id: '5a.carmen', obj: 'walk up to Carmen: the vision ends, two Burrowers come', do: 'walk', to: [460.6, 89, 369.6], tol: 0.4, then: { until: `__actors.manager.get(0x1e1c)?.behavior?.kind !== 'dormant'`, timeout: 15 }, expect: { gone: [0x1dea], awake: [0x1e1c, 0x1e1e] } },
  { id: '5a.burrowers', obj: 'fight the two Burrowers in the garden', do: 'arena', stand: [458, 89, 362], prey: [0x1e1c, 0x1e1e], until: `[0x1e1c, 0x1e1e].every((u) => !__actors.manager.get(u)?.alive)`, timeout: 240, shot: true },
  // The front courtyard: Detector 21bb (or 21bc from the west) -> Relay 17db: the CartWheelers
  // 1b28 / 1b29 / 1b2a break out through the windows (Damage Action Objects 2332..2334) and Object
  // Cloner 21bd sends four Burrowers (copies of 17da / 21bf, two at a time).
  { id: '5a.courtyard', obj: 'south into the asylum courtyard: CartWheelers and Burrowers', do: 'walk', to: [466, 95.7, 282], then: { wait: 2 } },
  { id: '5a.court-fight', obj: 'fight until the courtyard is clear', do: 'arena', stand: [462, 95.7, 280], hold: 18, until: `(() => { const cl = __actors.director.cloners?.get(0x21bd); return [0x1b28, 0x1b29, 0x1b2a].every((u) => !__actors.manager.get(u)?.alive) && (!cl || cl.remaining <= 0) && !__actors.manager.actors.some((a) => a.spawned && a.alive && a.entity?.className === 'Burrower' && a.state !== 'idle'); })()`, timeout: 300, shot: true },
  // The front door is barred: a crate (Pushable 2303) stands against it with junk (Breakables
  // 2309 / 230a / 230b / 230e) round it. Detectors 231c / 231e / 231f (filter 3: Pushables) over
  // the junk blow a piece up when the crate is pressed into it: pulled north it breaks 230e and
  // leaves the door's handle end free.
  { id: '5a.crate', obj: 'pull the crate away from the front door (it breaks the junk 230e)', do: 'push', uid: 0x2303, stand: [457, 95.75, 266.6], dir: [0, 1], key: 'KeyS', secs: 4, until: `__pt.center(0x2303)[2] > 266.3`, expect: { destroyed: [0x230e] } },
  { id: '5a.exit', obj: 'try the locked front door ed9: on to 5b (Level Transition 167f)', do: 'use', uid: 0xed9, stand: [457.3, 95.75, 264.3], transition: 0x167f, then: { level: '5b Asylum' }, expect: { level: '5b Asylum' }, shot: true },
  // ---- 5b Asylum Interior ----
  { id: '5b.arrive', obj: 'arrive from 5a at the North Spawn (the asylum vestibule)', do: 'wait', until: 'true', timeout: 5, expect: { level: '5b Asylum' }, shot: true },
  // Into the lobby (glass floor over the basement): Detector 116a plays "Camera" 258a (28:9,
  // Killjoy greets Torque). The sequence closes the doors 10de / 10df (Off at 0.6 / 1.6 s) and
  // locks them at its end (Disable); its end wakes the lobby CartWheelers (Timer 1408 -> Object
  // Cloner 1167) and takes the projector 140e's invulnerability off (Relay 3217).
  { id: '5b.lobby', obj: 'into the lobby: Killjoy greets Torque ("Camera" 258a)', do: 'walk', to: [197, 97.7, 186], then: { cine: true, wait: 2 }, expect: { played: [0x258a] }, shot: true },
  // The projector 140e high on the west wall (Breakable 313b round it, 15 health; its break
  // BlowUps 140e) shows Killjoy; broken, it unlocks the door 10de north (outOnBroken Enable).
  { id: '5b.lobby-projector', obj: 'shoot the lobby projector: the north door unlocks', do: 'break', from: [196.84, 97.7, 182.12], uids: [0x313b], aim: [194.31, 101.6, 177.4], until: `!__actors.manager.get(0x140e)?.alive`, then: { fight: 30 }, expect: { dead: [0x140e], unlocked: [0x10de] }, shot: true },
  // Up the stairs behind 10de; Detector 2bee (x 177.3..177.8 at the gallery's end) plays "Camera"
  // 2bed (28:17): Torque drops through a hole to the theatre's doors, where a projected Killjoy
  // tells him he must "prove" himself first. The theatre doors 12ac / 12ad are disabled until
  // Count Down 12ab (3) has had the three projectors 2c4e / 2c4f / 2c50 broken (their p21 Off).
  { id: '5b.upstairs', obj: 'upstairs past the gallery: Killjoy bars the theatre ("Camera" 2bed)', do: 'walk', to: [176.6, 103.2, 148.3], tol: 0.4, relocates: true, then: { cine: true, wait: 2 }, expect: { played: [0x2bed] }, shot: true },
  // Projector 2c4f (the corridor's, high on its south wall): Detector 2a82 takes its
  // invulnerability off (Relay 2daf, InvulnerabilityOff) and prefetches the vision 2a6c.
  { id: '5b.shelf-room', obj: 'east along the corridor (Detector 2a82: the corridor projector can be hit)', do: 'walk', to: [188.4, 97.7, 152.6], tol: 0.25, then: { wait: 1 } },
  { id: '5b.proj-2c4f', obj: 'shoot the corridor projector 2c4f', do: 'break', from: [181.2, 97.66, 147.1], uids: [0], aim: [179.2, 99.6, 146.1], weapon: '4:5', until: `!__actors.manager.get(0x2c4f)?.alive`, then: { fight: 20 }, expect: { dead: [0x2c4f] } },
  // Projector 2c4e is in the basement: down the hole at (180, 169) (5.4 m; its four Clamber
  // Points are for coming back up), Detector 29f8 plays "Camera" 2942 (28:13: a projected Killjoy,
  // Mainliners from Object Cloner 12a3) and its end takes 2c4e's invulnerability off (Relay 2dad).
  { id: '5b.hole-rim', obj: 'to the hole in the floor by the stairs', do: 'walk', to: [180.2, 97.1, 171.6], tol: 0.3 },
  { id: '5b.basement', obj: 'drop into the basement', do: 'route', pts: [[180.2, 97.1, 170.6], [180.2, 91.7, 169]] },
  { id: '5b.basement-cam', obj: 'the basement: Killjoy and his Mainliners ("Camera" 2942)', do: 'walk', to: [177.6, 91.7, 154], tol: 0.6, then: { cine: true, wait: 2, fight: 40 }, expect: { played: [0x2942] }, shot: true },
  { id: '5b.proj-2c4e', obj: 'shoot the basement projector 2c4e', do: 'break', from: [168.3, 91.82, 148.4], uids: [0], aim: [169.3, 95.9, 149.4], weapon: '4:5', until: `!__actors.manager.get(0x2c4e)?.alive`, then: { fight: 20 }, expect: { dead: [0x2c4e] } },
  // The basement door f31 is locked by the camera's end (Relay 2947); the crate 29b8 pushed
  // west against the shelves (Detectors 14fb / 13cc, filter 3: Pushables) topples them (STOMPs
  // 14fa / 14e7) and unlocks it (Relay 13e5).
  // Two junk Breakables 13c7 / 13c8 stand in the crate's way (their breaks count Count Down
  // 13ca down: Relay 13cb Enable on the crate).
  { id: '5b.junk', obj: 'shoot the junk in front of the basement crate', do: 'break', from: [183.4, 91.7, 156.3], uids: [0x13c7, 0x13c8], weapon: '4:5', expect: { destroyed: [0x13c7, 0x13c8] } },
  { id: '5b.shelves', obj: 'push the crate into the shelves: the basement door unlocks', do: 'push', uid: 0x29b8, stand: [183.4, 91.7, 154.8], dir: [-1, 0], secs: 6, until: `__pt.center(0x29b8)[0] < 178.2`, then: { wait: 5 }, expect: { played: [0x14fa, 0x14e7], unlocked: [0xf31] } },
  // The boiler room: Detector 29f6 takes the invulnerability off the boards 29ee / 29ef / 29f0
  // (Relay 29f3) nailed over the door 321e; their breaks count Count Down 29f1 down, which
  // unlocks it: the way back up.
  { id: '5b.boiler', obj: 'through door f31 to the boiler room (Detector 29f6)', do: 'walk', to: [192.4, 92.7, 184.5], tol: 0.5, then: { wait: 1, fight: 20 } },
  { id: '5b.boards', obj: 'shoot the boards off the boiler-room door', do: 'break', from: [193.2, 92.7, 189.4], uids: [0x29ee, 0x29ef, 0x29f0], weapon: '4:5', expect: { destroyed: [0x29ee, 0x29ef, 0x29f0], unlocked: [0x321e] } },
  // Detector 129c (the stage room's entrance) is a 1 x 4 x 10 m slab turned 51 degrees at
  // (164, 98.6, 187): the walk ends on its middle, not up to 0.6 m off it.
  // Up through 321e and west along the ground floor to the stage room: through the doors 10dc /
  // 10dd (their use is the checkpoint, Relay 31de -> Autosave 2ac0), Detector 129c plays "Camera"
  // 1296 (28:10: Killjoy on a stage), which shuts the doors behind (Relays 1297 / 1298) and
  // projects a barrier on them (projector 1bfb on Switch 1bfc, Invisible Static Object 32e1).
  { id: '5b.stage-room', obj: 'up through the boiler-room door, west to the stage room ("Camera" 1296)', do: 'walk', to: [164, 97.2, 187], tol: 0.3, then: { cine: true, wait: 2, fight: 30 }, expect: { played: [0x1296], checkpoint: 0x2ac0 }, shot: true },
  // The rope and the picture: the rope 2b3f (Breakable 30c7 / 2b58 round it) holds the
  // hoist; shot through, Relay 2b46 runs the Mechanisms 2b42 / 2b43 / 2b44 (2b42 carries the
  // crate 2b2c down 2.5 m, Object Grouper 2b47) and Timer 2a1a unlocks the door bac west (Relay 1c0c).
  { id: '5b.rope', obj: 'shoot the hoist rope: the west door unlocks', do: 'break', from: [174.75, 97.66, 203.6], uids: [0x2b3f], aim: [176.8, 99.6, 203.68], weapon: '4:5', then: { wait: 3 }, expect: { destroyed: [0x2b3f], unlocked: [0xbac] } },
  { id: '5b.west-door', obj: 'through the west door bac', do: 'use', uid: 0xbac, then: { wait: 1 } },
  // The planks de7 / de9 / deb over the door bad: their breaks count Count Down dec down (Relay ded: Enable).
  { id: '5b.planks', obj: 'shoot the planks off the door bad', do: 'break', from: [156.5, 97.66, 199.4], uids: [0xde7, 0xde9, 0xdeb], weapon: '4:5', expect: { destroyed: [0xde7, 0xde9, 0xdeb], unlocked: [0xbad] } },
  { id: '5b.bad', obj: 'through the door bad to the west wing', do: 'use', uid: 0xbad, then: { wait: 1 } },
  // The cage box under the attic hatch: the crate 29ba in the
  // second-floor cell behind door 1115 goes out into the corridor and under the hatch at
  // (153.5, 206.4) (Clamber Points 110b / 110c / 110d / 1dbb, 108.8 m: 4.1 m above the crate's top).
  // The cell door is a Switch that Detector 324e (filter 3) disables while a Pushable stands
  // in its doorway, so it cannot shut on the crate. (A walk into the cell got stuck at the door:
  // run v1; the use stays, its aim is open, docs/playthrough.md "5 Asylum".)
  { id: '5b.cell', obj: 'open the cell door 1115', do: 'use', uid: 0x1115, then: { wait: 1 }, expect: { open: [0x1115] } },
  { id: '5b.crate-1', obj: 'pull the crate to the cell door', do: 'push', uid: 0x29ba, stand: [149.55, 103.2, 199.9], dir: [0, -1], key: 'KeyS', secs: 4, until: `__pt.center(0x29ba)[2] < 199.7` },
  // Lined up with the doorway (z 199.35..199.75): a pull that went on past the mark (run final3:
  // the crate at z ~198) is pushed back first, or the push east meets the wall beside the door.
  { id: '5b.crate-1b', obj: 'line the crate up with the cell door', do: 'push', uid: 0x29ba, stand: [149.55, 103.2, 0], rel: [0, -1.3], dir: [0, 1], secs: 2, skipDone: true, until: `__pt.center(0x29ba)[2] > 199.35` },
  { id: '5b.crate-2', obj: 'push the crate out into the corridor', do: 'push', uid: 0x29ba, stand: [147.75, 103.2, 199.66], rel: [-1.8, 0], dir: [1, 0], secs: 6, until: `__pt.center(0x29ba)[0] > 153.4` },
  { id: '5b.crate-3', obj: 'push the crate under the attic hatch', do: 'push', uid: 0x29ba, stand: [153.42, 103.2, 197.9], dir: [0, 1], secs: 8, until: `__pt.center(0x29ba)[2] > 206.2` },
  { id: '5b.on-crate', obj: 'jump onto the crate', do: 'route', pts: [[153.42, 104.8, 206.25]], timeout: 10 },
  { id: '5b.attic', obj: 'climb through the hatch into the attic', do: 'clamber', from: [153.42, 104.75, 206.3], face: [[151.75, 109.2, 206.35]] },
  { id: '5b.cp-attic', obj: 'the attic: checkpoint (Detector 2f99)', do: 'walk', to: [150.5, 108.7, 182.5], tol: 0.6, expect: { checkpoint: 0x2ac1 } },
  // The wheel and the current: the chain 31ef (a Pushable) moved and let go
  // (p55) plays "ReBirthActor" (28:28), lights the pit's glass (Visibility Toggler 3129 shows
  // Decoration 3028) and enables Detector 2bc2, whose "Camera" 2945 (28:11) takes the third
  // projector 2c50's invulnerability off (Relay 2db0) and sends Slayers and Mainliners (12b2 / 12bc).
  { id: '5b.wheel', obj: 'pull the generator chain', do: 'push', uid: 0x31ef, stand: [136.3, 107.2, 166.5], dir: [0.707, 0.707], secs: 5, until: `!!__world.world.get(0x2c6a).s.played`, expect: { played: [0x2c6a] } },
  { id: '5b.attic-cam', obj: 'back across the attic ("Camera" 2945)', do: 'walk', to: [147, 108.7, 178.3], tol: 0.5, then: { cine: true, wait: 2, fight: 40 }, expect: { played: [0x2945] }, shot: true },
  { id: '5b.proj-2c50', obj: 'shoot the attic projector 2c50 (aimed at the foyer): the theatre unlocks', do: 'break', from: [181.8, 108.66, 172.4], uids: [0], aim: [179.8, 110.6, 173.4], weapon: '4:5', until: `!__actors.manager.get(0x2c50)?.alive`, then: { fight: 20 }, expect: { dead: [0x2c50], unlocked: [0x12ac, 0x12ad] } },
  // The caged projector and its beam: the attic hatch is covered by a projected
  // trap door (Projector Effect 1c3a on 1c39, Invisible Static Object 2308) from the caged
  // projector 31f3 (Object Grouper 3205 with the cage crate 32f6). Dragged east into Detector
  // 32fc (filter 3), the crate turns it off (Relay 1c3e: 2308 Off); while it stands there the
  // beam stays off.
  { id: '5b.cage-1', obj: 'drag the caged projector east', do: 'push', uid: 0x32f6, stand: [172.5, 108.7, 192.4], dir: [1, 0], key: 'KeyS', secs: 8, until: `__pt.center(0x32f6)[0] > 174.5 || !!__world.world.get(0x2308).s.collisionOff` },
  { id: '5b.cage-2', obj: 'push it on until the beam stops', do: 'push', uid: 0x32f6, stand: [172.9, 108.7, 192.4], dir: [1, 0], secs: 6, until: `!!__world.world.get(0x2308).s.collisionOff` },
  { id: '5b.hatch', obj: 'back to the attic hatch', do: 'walk', to: [151.5, 108.7, 206.35], tol: 0.4 },
  { id: '5b.hatch-down', obj: 'drop through the hatch onto the crate and the floor', do: 'route', pts: [[153.5, 104.8, 206.4], [155.2, 103.2, 204.3]] },
  // The theatre: Detector 12d4 / 164d -> Relay 12d6 -> Timer 12d7: "Camera" 1ba4 (28:18,
  // Killjoy on his stage; projectors on), checkpoint 2ac2, Killjoy's KilljoyRoot 1ba1 (he
  // raises the CartWheelers 150f / 1510 / 1511 lying there).
  { id: '5b.theatre', obj: 'down to the operations theatre: Killjoy ("Camera" 1ba4)', do: 'walk', to: [160, 97.7, 149.4], tol: 0.6, then: { cine: true, wait: 2 }, expect: { played: [0x1ba4], checkpoint: 0x2ac2 }, shot: true },
  // Through d3e into the theatre: Detector 12cf -> Relay 12ca: the door shuts (12cc), KilljoyRoot
  // 1508 (four corpses) and his projectors lose their invulnerability (Relay 32fe; 1503 by 32ff).
  { id: '5b.stage', obj: 'into the theatre: the projectors can be hit', do: 'walk', to: [151.2, 97.7, 160.5], tol: 0.6, then: { wait: 2 } },
  // Five projectors keep Killjoy on screen (Projector Effect 1501, p10): 1503 / 1506 / 1502 by
  // their fuses 30c5 / 30c4 / 30c3 (BlowUp), the elevated 1505 by the fuse box 2b0b, the caged
  // 2b0a by its rope 2b2e (Relay 2b38 drops the cage, Timer 2b37 BlowUp). Each break goes to
  // Relay 164c (a taunt), the fifth to 1bf8; the last one leaves Killjoy 10000 damage
  // (projector.ts) and Relay 15ac -> Timers 151b / 15ad -> Sound 1641 -> "RebirthMachine Actor" 2d4d.
  { id: '5b.proj-1503', obj: 'the stage projector by the door (fuse 30c5)', do: 'break', from: [154.5, 97.66, 160.4], uids: [0x30c5], aim: [156.5, 99.2, 160.4], weapon: '4:5', until: `!__actors.manager.get(0x1503)?.alive`, expect: { dead: [0x1503] } },
  { id: '5b.proj-1506', obj: 'the projector by the far door (fuse 30c4)', do: 'break', from: [154.4, 97.66, 146.2], uids: [0x30c4], aim: [156.4, 99.2, 146.2], weapon: '4:5', until: `!__actors.manager.get(0x1506)?.alive`, expect: { dead: [0x1506] } },
  { id: '5b.proj-1502', obj: 'the projector by the window (fuse 30c3)', do: 'break', from: [145.1, 97.66, 153.7], uids: [0x30c3], aim: [143.1, 99.5, 153.7], weapon: '4:5', until: `!__actors.manager.get(0x1502)?.alive`, expect: { dead: [0x1502] } },
  { id: '5b.proj-1505', obj: 'the elevated projector (its fuse box 2b0b)', do: 'break', from: [148.3, 97.66, 159], uids: [0x2b0b], aim: [146.3, 99.0, 159.0], weapon: '4:5', until: `!__actors.manager.get(0x1505)?.alive`, expect: { dead: [0x1505] } },
  { id: '5b.proj-2b0a', obj: 'the caged projector: shoot its rope 2b2e', do: 'break', from: [145, 97.66, 141.5], uids: [0x2b2e], aim: [144.13, 99.5, 140.37], weapon: '4:5', until: `!__actors.manager.get(0x2b0a)?.alive`, then: { wait: 3 }, expect: { dead: [0x2b0a] } },
  { id: '5b.killjoy-gone', obj: 'Killjoy is gone: the machine crashes ("RebirthMachine Actor" 2d4d)', do: 'wait', until: `!!__world.world.get(0x2d4d).s.played`, timeout: 90, expect: { played: [0x2d4d], gone: [0x1500] }, shot: true },
  // The button and the beam: the Switch 2bec (enabled for it by
  // 2d4d's Relay 3311 -> 2e58) runs Relay 2e45 -> 2e3d: the arcs and the Object Generator 2e3f,
  // whose Ring Damage 3:4555 puts the Killjoy Rebirth Effect 4:1325 on the player standing in
  // it (fx/rebirth.ts: weapons away, eight rebirth grenades 4:804).
  { id: '5b.button', obj: 'press the yellow button by the machine', do: 'use', uid: 0x2bec, then: { wait: 2 } },
  { id: '5b.beam', obj: 'stand in the purple beam: the rebirth power', do: 'walk', to: [148.3, 97.7, 148], tol: 0.3, then: { until: `!!__weapons.service.stowed && __weapons.service.throwable?.id === '4:804'`, timeout: 20 } },
  // The monster: the insanity creature 2c3b (immune to all but type 17, the grenade's
  // Radius Damage 4:805) hit, its Damaged runs Relay 2d51: "Instanity Creature" 2d53 / 2e56,
  // the fade 2f7f, Timer 1640 -> "Rail" 2e55 and the window's Breakable 302d gone (Relay 302e).
  { id: '5b.monster', obj: 'throw the rebirth at the monster', do: 'throw', uid: 0x2c3b, until: `!!__world.world.get(0x2d53).s.played`, timeout: 60, then: { cine: true, until: `!!__world.world.get(0x2e55).s.played`, timeout: 60, wait: 2 }, expect: { played: [0x2d53, 0x2e55] }, shot: true },
  // Out of the window: Detector 13c2 just outside the theatre's west window (sill 99.1 m,
  // 1.4 m over the floor) -> Level Transition 13c1 -> 6a Woods "West Spawn".
  { id: '5b.exit', obj: 'jump out of the theatre window: on to 6a Woods', do: 'leap', from: [144.2, 97.66, 148], to: [130, 97.7, 148], after: 0.35, hold: 1.5, transition: 0x13c1, then: { level: '6a Woods' }, expect: { level: '6a Woods' }, shot: true },
  // ---- end of 5a / 5b Asylum ----
  // ---- 6a / 6b Woods (block owned by the chapter 6 route) ----
  // 6a The Woods, arriving from 5b at the West Spawn (1419) in the walled lane at the north end;
  // the level runs south through the woods to Level Transition 1a88 by the creek. Read from the
  // level's message graph (tools/entities.ts --graph) and played in the browser
  // (docs/playthrough.md "6 Woods").
  { id: '6a.arrive', obj: 'arrive from 5b at the West Spawn', do: 'wait', until: 'true', timeout: 5, expect: { level: '6a Woods' }, shot: true },
  // Detectors 15fb / 1be7 / 1d04: the Burrowers 1bea / 1be9 / 1be8 / 1bff burrow past along their
  // waypoints and are destroyed at the end (Behavior Changer p17 -> Message Relays 1c14.. Destroy),
  // two crows (Ambient Creatures 1c22 / 1c29) fly off; Detector 22c0 starts the rain (22b1).
  { id: '6a.lane', obj: 'east out of the lane: Burrowers run past, crows fly off', do: 'walk', to: [240, 98.5, 672], tol: 1, then: { wait: 3 } },
  // The hedge maze west of the lane: Detector 2088 -> Relay 2087: the two Infernas 207f / 2080
  // speak (Speech Players 2164 / 2165, 25:88) and walk their WaypointBehaviors (215d / 215f ->
  // RootPlayAnim 216a / 216b -> 216c / 216d) to Waypoints 2162 / 2163, whose arrival (Relay 2411)
  // destroys them; Detector 2167 (enabled by 2087) fades them out first (Screen Fader 2412 ->
  // Relay 240f). The maze's Burrower Detectors 1f98 / 207d / 207e are enabled by 2081.
  { id: '6a.maze', obj: 'south through the maze past its heart (Detector 240c prefetches, 2088 starts the Infernas)', do: 'walk', to: [196.5, 99.1, 639.2], tol: 0.4 },
  // Behind the player, beyond the hedge he came through, they run to Waypoints 2160 / 2161, turn,
  // taunt (RootPlayAnim 216a / 216b: 10:691, 1 s) and run off to 2162 / 2163, where they vanish
  // (Relay 2411); their laughter (25:88) turns him back, and Detector 2167 (enabled by 2087) at
  // the hedge's gap fades them out (Screen Fader 2412 -> Relay 240f) if he gets there first.
  { id: '6a.maze-back', obj: 'back towards the laughter: the Infernas are gone', do: 'walk', to: [196.5, 99.1, 650.5], tol: 0.6, then: { until: `[0x207f, 0x2080].every((u) => !__actors.manager.actors.some((a) => a.entity?.uid === u && a.alive && a.ch.root.visible))`, timeout: 15 }, shot: true },
  // The note (Ammo Box 234d, p25: Inventory Add Remove 234e) by the first checkpoint.
  { id: '6a.cp1', obj: 'south out of the lane: checkpoint (Detector 2327)', do: 'walk', to: [234.2, 97.6, 622], expect: { checkpoint: 0x2328 } },
  // The phone (22af) rings by the road; looked at from Detector 2126, Visiblity Message Filter 2127
  // (20 % x 60 % of the screen) -> Relay 2128 -> Screen Fader 212c: the vision of the bus prisoners
  // (Visibility Togglers 213b / 213c, Projector Effect 2136, Time Scale 212b 20 %) until the sound
  // 25:90 ends (Relay 212d).
  { id: '6a.vision-walk', obj: 'east to the ringing phone', do: 'walk', to: [279, 95.3, 612], tol: 1 },
  { id: '6a.vision', obj: 'look along the road: the prisoners\' vision', do: 'look', at: [278.5, 98.2, 605.5], then: { until: `!!__world.world.get(0x212c).s.fired || __world.world.get(0x2128).s.left === 0`, timeout: 10, wait: 1 }, shot: true },
  // Detector 1795: the Burrowers 2040 / 2045 run their waypoints (Count Down 23ae) -> Object
  // Cloners 1794 -> 179d -> 17a6: Festers along the road. Checkpoint 2329 (Detectors a0a / 1509).
  { id: '6a.cp2', obj: 'south along the road past the Festers: checkpoint', do: 'walk', to: [275, 96.7, 540], tol: 1.5, then: { fight: 40 }, expect: { checkpoint: 0x2329 } },
  // Detectors 8b8 / 8b9 / 8bb / 8bc -> Relay 8ba: Object Cloner 1c4e, the Slayers a09 / 1c2f
  // (Timers 1dfe / 1dff) and the CartWheelers 1c4b..1c4d off the rocks; Count Down 2336 (five) ->
  // Relay 1c89 -> the Slayer 2337; Count Down 1c4a enables the Burrower Detectors 204e / 204f.
  { id: '6a.slayers', obj: 'the clearing: Slayers and CartWheelers', do: 'walk', to: [292, 96.7, 510], tol: 2, then: { wait: 4 } },
  { id: '6a.slayers-fight', obj: 'fight until the clearing is quiet', do: 'arena', stand: [292, 96.7, 505], hold: 20, until: `__world.world.get(0x2336).s.count === 0 && __world.world.get(0x1c4a).s.count === 0`, timeout: 240, shot: true },
  // The burnt ruin east: Detectors 19ad / 2142 / 2143 look through Visiblity Message Filter 1d1b
  // (or the pickup 1d1d) -> Relay 1d1e -> Screen Fader 1d25: the vision (the electric chair), then
  // the ruin burns (Relay 19ae: Fires 198f.., Timer 1d63 -> Object Cloner 1d09: CartWheelers off
  // the walls; Count Down 1d64 -> Burrowers 4fe / 19b0, Count Down 1d65 -> 19af).
  { id: '6a.ruin', obj: 'east to the burnt ruin', do: 'walk', to: [328, 97.7, 479], tol: 1 },
  { id: '6a.ruin-vision', obj: 'look into the ruin: the vision, the ruin burns', do: 'look', at: [336.9, 98.7, 484.4], then: { until: `__world.world.get(0x1d1e).s.left === 0`, timeout: 10, wait: 2 }, shot: true },
  { id: '6a.ruin-fight', obj: 'the ruin: CartWheelers off its walls, then Burrowers', do: 'arena', stand: [328, 97.7, 479], hold: 16, until: `__world.world.get(0x1d65).s.count === 0`, timeout: 240 },
  // West to the gully: Detectors 6f3 / 1519 / 151a -> Relay 1518: the stranger on the ledge (54b,
  // invulnerable) shoots the propane tank 1432 (KillEnemies 142c lists it, p3): Relay 225c, the
  // birch falls across the gully ("Birch01" 140d), the barrels burn (Relay 16d7); then the tank
  // 1429 (KillEnemies 225b) and he walks off. Detectors 2402 / 2403 do the same for a player who
  // walks on before he fires; Relay 1518 also puts the ruin's fires out (Relay 19bb).
  { id: '6a.gully', obj: 'west to the gully: the stranger on the ledge throws a molotov at the tank', do: 'walk', to: [263.5, 95, 449.5], tol: 0.8, then: { until: `!!__world.world.get(0x1432)?.destroyed`, timeout: 30, wait: 4 }, expect: { destroyed: [0x1432], played: [0x140d] }, shot: true },
  { id: '6a.gully-2', obj: 'his second molotov: the tank 1429 (KillEnemies 225b), then he walks off', do: 'wait', until: `!!__world.world.get(0x1429)?.destroyed`, timeout: 30, then: { wait: 2 } },
  // East along the gully to its end under the truck: the molotovs (Ammo Boxes 1cc1..1cc3 ->
  // Relay 23f4, or Detector 23f2) -> Relay 2158: the stranger (1cc4) walks to the truck's jack
  // and speaks (Waypoint 1cc7 -> Speech Player 2159, 25:92); Timer 1db0 sends Object Cloner 1daf's
  // Mainliners and the Nooseman. The gully's end is closed to the truck's side (Invisible Static
  // Object 1a47, player only): the way back is the gully and the stranger's ledge.
  { id: '6a.molotovs', obj: 'east along the gully: the molotovs under the truck', do: 'walk', to: [297.6, 91.4, 402.5], tol: 1, loot: 3 },
  { id: '6a.ambush', obj: 'the stranger goes to the truck; Mainliners and the Nooseman come', do: 'wait', until: `__world.world.get(0x2158).s.left === 0`, timeout: 10, then: { wait: 3, fight: 90 } },
  // Up onto his ledge by Clamber Points 1bd4 (2:637) and 1bd5; climbing removes him (Relay 241a).
  { id: '6a.ledge', obj: 'climb onto the stranger\'s ledge', do: 'clamber', from: [246.6, 95.9, 439.5], face: [[244.5, 98.8, 439.5], [241.5, 101.6, 439.5]], stands: [null, [243.5, 98.3, 439.5]] },
  { id: '6a.cp3', obj: 'south along the ledge: checkpoint (Detector 1ceb)', do: 'walk', to: [240.5, 101.95, 428], expect: { checkpoint: 0x16c9 } },
  // Detectors 13e7 / 16eb / 16ed -> Relay 13ee: the CartWheelers 522..525 leap off the cliffs.
  { id: '6a.cliffs', obj: 'along the cliffs: CartWheelers leap down', do: 'walk', to: [237, 99.8, 410], tol: 1.5, then: { wait: 3, fight: 60 } },
  // Detectors 151d / 1cd7 / 1cd8 -> Relay 1cd9: the Slayer 1cd2 by the truck.
  { id: '6a.road', obj: 'down to the road: the Slayer by the truck', do: 'walk', to: [262, 92.6, 389], tol: 1.5, then: { fight: 60 } },
  // The truck hangs over the creek on its jack (Animating Static 23a1); the jack's Switch a08 has
  // no model (Interaction Properties 2:924). Used: Timer 23a3 -> "Truck" a9b (the jack) -> "Truck"
  // 6aa: the truck falls into the creek; the invisible box 1be5 under it turns solid.
  { id: '6a.jack', obj: 'kick the jack: the truck falls into the creek', do: 'use', uid: 0xa08, then: { wait: 12 }, expect: { played: [0xa9b, 0x6aa] }, shot: true },
  { id: '6a.creek', obj: 'down into the creek', do: 'walk', to: [300, 83.9, 368], tol: 1.5, drop: 6 },
  // West along the creek: checkpoint 232b (Detector 232a); the pond in the cave beyond: Detector
  // 1ddf with Visiblity Message Filter 20d3 (35 % x 20 %) -> Relay 20cc: Torque's children
  // (1af3 / 1af4: Speech Players 20ff / 2101, a voice line), Detector 1de0 enabled.
  { id: '6a.cp4', obj: 'west along the creek: checkpoint', do: 'walk', to: [268, 84.4, 343], tol: 1.5, drop: 6, expect: { checkpoint: 0x232b } },
  { id: '6a.pond-walk', obj: 'into the cave by the pond', do: 'walk', to: [226, 83.5, 320], tol: 1.5 },
  { id: '6a.children', obj: 'look across the pond: the children', do: 'look', at: [209.6, 84.8, 321.4], then: { until: `__world.world.get(0x20cc).s.left === 0`, timeout: 10, wait: 6 }, shot: true },
  // They walk off and vanish (Waypoints 2116 / 2119 p0 Destroy, Count Down 211a -> Relay 211b,
  // Timer 23f0 at the latest): Timer 20e9 -> the Burrower 20e2 and Object Cloner 21d5's
  // CartWheelers (Count Down 21d6 -> the Slayer 21da, Burrower Detectors 21d8 / 21d9); crossing
  // Detector 1de0 -> Relay 2125: Object Cloner 1dde's Mainliners.
  { id: '6a.cave-fight', obj: 'the cave: Burrower, CartWheelers, Mainliners, a Slayer', do: 'arena', stand: [230, 83.6, 320], hold: 16, until: `(() => { const cl = __actors.director.cloners?.get(0x1dde); return __world.world.get(0x21d6).s.count === 0 && (!!cl && cl.remaining <= 0) && !__pt.hostiles(25).some((h) => ['chase', 'attack', 'shoot'].includes(h.st)); })()`, timeout: 300, shot: true },
  // Out of the creek over the fallen truck (its box 1be5, 1.7 m: a jump) and Clamber Point 5b5.
  { id: '6a.truck', obj: 'back east to the fallen truck', do: 'walk', to: [302, 83.9, 360.5], tol: 0.8 },
  { id: '6a.truck-top', obj: 'jump onto the truck', do: 'route', pts: [[302, 83.9, 360.5], [302, 85.6, 356.5]], timeout: 10 },
  { id: '6a.bank', obj: 'climb out of the creek (Clamber Point 5b5)', do: 'clamber', from: [302.8, 85.6, 355.4], face: [[303.4, 88.9, 353.6]] },
  { id: '6a.exit', obj: 'south along the bank: Detector 1a87 -> Level Transition 1a88 to 6b', do: 'walk', to: [315.5, 88.9, 320], then: { level: '6b Woods' }, expect: { level: '6b Woods' }, shot: true },
  // 6b The Beach, arriving from 6a at the NorthEast Spawn (137c) on the path down to the shore;
  // its story exit is Detector d50 -> Level Transition d51 to 1b "North Spawn" (the return to the
  // prison) on the cliff top east of the pier; 137e only leads back to 6a.
  { id: '6b.arrive', obj: 'arrive from 6a at the NorthEast Spawn', do: 'wait', until: 'true', timeout: 5, expect: { level: '6b Woods' }, shot: true },
  // Horace behind the power station's fence: Detector 159e with Visiblity Message Filter 159f ->
  // Relay 1e5b -> Reputation Points Message Filters 1e5c / 1e5e / 1e60 pick "Horace" 1e5f / 1e5d /
  // 1598 (in the world, no camera); Timer 159a then fades him out (Screen Fader 159c, Relay 15a0).
  { id: '6b.horace-walk', obj: 'down the path to the power station', do: 'walk', to: [336, 88.9, 326], tol: 1.5 },
  { id: '6b.horace', obj: 'look through the fence: Horace (by reputation)', do: 'look', at: [346, 89.6, 332], then: { until: `[0x1598, 0x1e5d, 0x1e5f].some((u) => !!__world.world.get(u).s.played)`, timeout: 15, wait: 6 }, shot: true },
  // Detector a25 -> Relay a27: Timers 1dc6..1dc8 send CartWheelers a28 / a23 / a22 at Clem (49a),
  // who fights them (Behavior Changer a2d: KillEnemies a2e, molotovs) and calls out (25:10).
  // Their deaths count Count Down a36 down -> Behavior Changer a37: Clem's talk and his escort;
  // Relay 2088 removes Relay 2087, which would destroy him when the player reaches the beach
  // (Detector 897) first.
  { id: '6b.clem', obj: 'down to the shore path: CartWheelers on Clem', do: 'walk', to: [322, 86, 310], tol: 1.5, then: { wait: 2 } },
  { id: '6b.save-clem', obj: 'save Clem: kill the three CartWheelers', do: 'arena', stand: [340, 83, 296], hold: 18, until: `__world.world.get(0xa36).s.count === 0`, timeout: 150, expect: { actorAlive: [0x49a] }, shot: true },
  { id: '6b.clem-talk', obj: 'up to Clem: he talks, then leads', do: 'walk', to: [350.5, 83, 297], tol: 1, then: { until: `__actors.manager.get(0x49a)?.behavior?.kind !== 'talk'`, timeout: 40 } },
  // His escort (WaypointBehavior a39, p8 the player) to Waypoint a3a (Relay 2086 -> Count Down
  // 2085); checkpoint 20e6 on the way (Detector 20e5).
  { id: '6b.follow', diag: allyDiag(0x49a), obj: 'follow Clem down to the beach', do: 'follow', uid: 0x49a, until: `__world.world.get(0x2085).s.count < 2 || !__actors.manager.get(0x49a)?.alive`, timeout: 150, fight: true, expect: { checkpoint: 0x20e6 } },
  // Detector 897 (a plane across the beach path) -> "camera" 147e (40 s): the beach; its end sends
  // Fester 147d, Object Cloner 894 and Relay 2086 (Count Down 2085 -> Behavior Changer 207c).
  { id: '6b.beach', obj: 'onto the beach: the cinematic', do: 'walk', to: [334, 81.7, 270], tol: 1.5, then: { cine: true, wait: 2 }, expect: { played: [0x147e] }, shot: true },
  // Along the beach with Clem: Fester waves (Object Cloners 894, 87f, a54, 1fe1) and Clem's chain
  // of Behavior Changers (843, a45, a4a, a4c -> FollowBehavior 138f). The door under the pier
  // opens to it: Relay 205c enables Detectors 203a / 2059 (from Count Downs 1d87 / 1d89, or Clem's
  // death, Relay a42).
  { id: '6b.shore', diag: allyDiag(0x49a), obj: 'east along the beach with Clem through the Fester waves', do: 'follow', uid: 0x49a, until: `__world.world.get(0x203a).enabled || __world.world.get(0x2059).enabled`, timeout: 600, fight: true, shot: true },
  // The door under the pier: Detector 203a (or a look from 2059) -> "Door" 2035: Fester 2034
  // bursts out through it.
  { id: '6b.door', obj: 'to the door under the pier: a Fester bursts out', do: 'walk', to: [447, 77.3, 226], tol: 1, then: { wait: 4, fight: 40 }, expect: { played: [0x2035] }, shot: true },
  // Inside the pier: Clamber Point 1d49 onto the beams, a plank up, then north across Detectors
  // 139a (Object Cloner 1399's Festers) and 139b (Relay 20e7: the oil drum platform's Breakable
  // 136b loses its invulnerability). The drowned men's vision on the way (Detector 161c /
  // Visiblity Message Filter 1f37 -> Screen Fader 1603).
  { id: '6b.pier-in', obj: 'climb into the pier', do: 'clamber', from: [445.4, 77.7, 218.3], face: [[445.4, 81.6, 216.2]] },
  // (The plank and landing north of the clamber are one leaf box of the pier's collision tree,
  // Static Object 17bf / 25:143: 5.1 x 5.5 x 5 m from the beams' floor up, docs/game-logic.md
  // §14.10. The way north is down to the pier's ground floor on the east and up its slope at x
  // 450..452 onto the beams: the route a walk found in a session.)
  { id: '6b.plank', obj: 'east down to the pier\'s ground floor and up its slope onto the beams', do: 'route', pts: [[447.5, 77.7, 216], [449.2, 77.7, 214], [450.5, 78.2, 211.6], [452, 80.1, 208], [451.6, 81.6, 205.6], [449, 81.6, 202.8]], timeout: 20 },
  { id: '6b.pier-north', obj: 'north along the beams (Detectors 139a / 139b)', do: 'walk', to: [446.5, 81.6, 200.5], tol: 0.8, drop: 3, then: { until: `__world.props.recs?.get(0x136b)?.invulnerable === false`, timeout: 5 } },
  // The oil drums (Breakable 136b round them, 1 health) shot: "OilDrumPlat" 136a, and Relay 13a4
  // makes the gas tanks 13a3 / 13ac / 13ad below breakable; one shot -> Relay 1393: the platform
  // burns (Fires 1d74..), every Fester and cloner of the beach is destroyed (Relay 136c), the map
  // shows by the exit (Visibility Toggler 13b6), Clem's last scene is armed (Relay 139e).
  { id: '6b.oil', obj: 'shoot the oil drum platform', do: 'break', from: [446.5, 81.6, 200.5], uids: [0x136b], until: `!!__world.world.get(0x136b)?.destroyed || !!__world.props.recs?.get(0x136b)?.broken`, then: { wait: 4 }, expect: { played: [0x136a] }, shot: true },
  { id: '6b.tanks', obj: 'shoot a gas tank under it: the platform burns, the Festers die', do: 'break', from: [446.5, 81.6, 200.5], uids: [0x13a3, 0x13ad, 0x13ac], until: `__world.world.get(0x1393).s.left === 0 || [0x13a3, 0x13ad, 0x13ac].some((u) => !!__world.props.recs?.get(u)?.broken)`, then: { wait: 4 }, shot: true },
  // Back up: onto the plank's landing (2 m, facing south from the beams), then through the hatch
  // onto the deck (Clamber Points 17db..), then south over the plank walk to the cliff top.
  { id: '6b.deck', obj: 'up onto the landing and through the hatch onto the deck', do: 'clamber', from: [446, 81.6, 203.5], face: [[445.8, 84.3, 206.5], [445, 87.3, 212]], stands: [null, [445.07, 83.73, 210.0]] },
  // With Clem alive: Detectors 6b7 / 202d (enabled by Relay 139e) -> Relay 202e -> "Clem" 6b8,
  // after which he is gone (Relay 138d).
  { id: '6b.cliff', obj: 'south over the walkway to the cliff top (Clem\'s farewell when he lives)', do: 'walk', to: [456, 85.5, 247], tol: 2, then: { wait: 2, cine: true }, shot: true },
  // The hut's floor is a box 0.74 m over the ground at its south-west corner (z 246.8): over the
  // player's step, so a player jumps onto it (`jumpAt`), then walks north through Detectors 1e54
  // (12:0 to Level Transition Msg Handler 1e55) and d50. Checked in a session: 1b's sewer.
  { id: '6b.hut', obj: 'east to the hut\'s porch', do: 'walk', to: [466.5, 85.3, 247.2], tol: 0.6 },
  { id: '6b.exit', obj: 'onto the hut floor and through it: Detector d50 -> Level Transition d51 to 1b (the return to the prison)', do: 'route', pts: [[466.9, 85.3, 246.8], [469.2, 86.2, 246.8], [471, 86.1, 250], [471.5, 86.1, 257.5]], jumpAt: [467.3, 246.8, 0.5], timeout: 25, then: { level: '1b PrisonDeathRow' }, expect: { level: '1b PrisonDeathRow' }, shot: true },
  // ---- end of 6a / 6b Woods ----
  // ---- 7 Return to Prison (block owned by the chapter 7 route) ----
  // "Return to Prison Test" (level 7): a cut-down copy of 6b's way out (same uids) that nothing in
  // the campaign leads to. The Player object (505.3, 79.9, 229.3) links a start kit of 22 pickups
  // that float 10 m over the beach (given at the start instead: ARRIVALS 7). Clem's scene (STOMP 6b8 behind Detector 6b7, enabled only by
  // Relay 139e from Waypoint a49, which nobody walks to here) and the Fester cloner a54 (no
  // input) never start in the test map [data]. The way out: the rock north (Clamber Point 6b4),
  // Detector 1481 -> Level Transition Msg Handler 1482 (12:0, the "return to prison" mail),
  // Detector d50 -> Level Transition d51 (1b, no spawn name: 1b's Player Spawn Point 82da from 7).
  { id: '7.arrive', obj: 'start in the Return to Prison test map', do: 'wait', until: 'true', timeout: 5, expect: { level: '7 ReturnToPrison' }, shot: true },
  { id: '7.climb', obj: 'clamber onto the rock north of the start (Clamber Point 6b4)', do: 'clamber', from: [505.3, 80.57, 233.1], face: [[505.3, 84.5, 236]] },
  { id: '7.exit', obj: 'north over the rock: Detector 1481 posts 12:0, Detector d50 fires Level Transition d51 (1b)', do: 'walk', to: [505, 84.3, 247.5], then: { level: '1b PrisonDeathRow' }, expect: { level: '1b PrisonDeathRow', played: [0x8283], checkpoint: true }, shot: true },
  // ---- r1b: 1b revisited (6b's d51 "North Spawn" 7ca3, or level 7's d51 to 82da: the sewer) ----
  // The mail 12:0 reaches Level Transition Msg Handler 8933: "Camera" 8283 (12:279, the return),
  // Level Transition Remover 8934 (6a / 6b) and Relay 7ca5, the revisit set-up: Relay 8280 blows
  // up chapter 1's creatures, 8281 destroys its Detectors, Hermes 7ea7 and Horace 83ab; Relay 8b7b
  // swaps the arrival room door's transition (enables Timer 8b79 / Relay 8c0c -> 8b7a, chapter
  // 5:625, destroys 79c4 / 8c0d -> 79c5); handler 7ca9 stores 11:0 for 1a.
  { id: 'r1b.arrive', obj: 'arrive in the sewer: the return-to-prison scene ("Camera" 8283)', do: 'wait', until: `!!__world.world.get(0x8283)?.s.played && !__world.world.activeCutscenes().length`, timeout: 90, expect: { played: [0x8283], level: '1b PrisonDeathRow' }, shot: true },
  // The scene's end (Timer 8936, 3 s) or Detector 7ee9 starts Object Cloner 7ee2: 15 rats drop
  // from the pipe over the arrival (FallBehavior 10:517); Detectors 7f03 / 7f04 open the ceiling
  // grates 7ea0..7ea3 (Timers 8aca / 8acb / 7f05 / 8ac8: Cloners 7ef5, 7eea, 7f02), 15 rats each.
  // A rat bites once, 10, when its leap lands, and one that misses waits where it landed
  // (specials/rat.ts): the sewer is run through, not fought.
  { id: 'r1b.sewer', obj: 'run north up the sewer and up the ladder 7a43: rats drop from the pipes and the grates (Object Cloners 7ee2, 7eea, 7ef5, 7f02)', do: 'ladder', run: true, from: [303.5, 60.3, 350.7], face: [303.5, 63, 352.5], top: 66.8, shot: true },
  // The upper sewer: Detector 7e19 (Autosave 8bea; the Fester 7e18 wakes), the flashback Movie
  // Player 8b67 (Detectors 8b64 / 8b68); Detector 7e0c wakes the Festers 7e08 / 7e0d (Behavior
  // Changers 7e09, Timer 7e11 -> 7e0e).
  { id: 'r1b.cp1', obj: 'the checkpoint at the ladder top (Detector 7e19: Autosave 8bea, the Fester 7e18 wakes)', do: 'walk', to: [295.7, 67.2, 353.4], then: { wait: 2, fight: 30 }, expect: { checkpoint: 0x8bea }, shot: true },
  { id: 'r1b.festers', obj: 'north into the pipe room (Detector 7e0c: the Festers 7e08 / 7e0d)', do: 'walk', to: [303.3, 71.4, 371], then: { wait: 2, fight: 40 }, shot: true },
  // Detector 7e2b sends the Burrower 7e1a (Behavior Changer 7e27: WaypointBehavior 7e26) to
  // Waypoint 7e25 by the barricade: Timer 7e29 (2 s) -> Timer 7e28 blows the boards 7e1b.. (and
  // 8be9 the rest); its death starts Object Cloner 8bd9 (four Mainliners).
  { id: 'r1b.burrower', obj: 'east (Detector 7e2b): the Burrower 7e1a walks to the barricade (WaypointBehavior 7e26)', do: 'walk', to: [331.7, 73.2, 375], then: { wait: 6, fight: 40 } },
  // Killed before it gets there, the Burrower leaves the boards up: a hit on 7e20 blows the
  // Breakable 8be8 (1 health), whose break starts Timer 7e28 as the waypoint would have.
  { id: 'r1b.boards', obj: 'the barricade: shoot the boards 7e20 if the Burrower did not blow them', do: 'break', from: [331.6, 73.2, 384.5], uids: [0x7e20], unless: `!!__world.world.get(0x7e1b)?.destroyed`, then: { until: `!!__world.world.get(0x7e1b)?.destroyed`, timeout: 10 }, expect: { destroyed: [0x7e1b] } },
  { id: 'r1b.mainliners', obj: 'through the barricade (Detector 8be6: Object Cloner 8be2, three Mainliners)', do: 'walk', to: [336.2, 73.2, 397], then: { wait: 2, fight: 40 }, shot: true },
  // An Autosave hurt recently is skipped (save/rules.ts, 0x100970a0) and Detector 8beb fires once:
  // the Mainliners are dealt with short of it.
  { id: 'r1b.corridor', obj: 'up into the corridor east, clear of the Mainliners', do: 'walk', to: [372, 79.2, 420.5], then: { wait: 2, fight: 40 } },
  { id: 'r1b.cp2', obj: 'on east: checkpoint (Detector 8beb: Autosave 8bec)', do: 'walk', to: [379.6, 79.2, 420.5], then: { wait: 2, fight: 30 }, expect: { checkpoint: 0x8bec }, shot: true },
  { id: 'r1b.lever', obj: 'the lever 7b5b opens the gate 6548', do: 'use', uid: 0x7b5b, then: { wait: 2 }, expect: { open: [0x6548] }, shot: true },
  // East through the gate: Detector 83d5 (enabled by Relay 7ca5) and 89f0 / 8c2d play the
  // insanity vision (Sound Effect 83d3 -> Screen Faders 83d8 / 83d9, Relay 83e0: the CartWheelers
  // 83e6 / 83eb, Fester 83fa wake). Chapter 1's way east is shut: Relay 7ca5 closes 66c4 / 7ca6 /
  // 6435 / 6433, 6130 / 8ae9 / 6419 / 6421 never unlock. The way on is the locked door 64e1 (10
  // health) at the corridor's east end, smashed.
  { id: 'r1b.door', obj: 'smash the locked door 64e1 (10 health) at the east end of the corridor', do: 'break', from: [429, 79.65, 422.6], uids: [0x64e1], then: { fight: 30 }, expect: { destroyed: [0x64e1] }, shot: true },
  // The walkway over the arena: inside Detector 83c0 (enabled by Relay 7ca5) the Visiblity
  // Message Filter 83c1 (p4 30 m, p5 2) passes with Horace's spot on screen -> Relay 83bc ->
  // "Horace" 89f4 (12:274, in the world): Horace (83b8) zaps the locked gate 6134 open (its
  // transform keys swing it to -14 degrees at 12.0 s) and is removed at the end.
  { id: 'r1b.walkway', obj: 'onto the walkway by the ledge top (Detector 83c0)', do: 'walk', to: [461.5, 79.7, 443], tol: 0.5 },
  { id: 'r1b.horace', obj: 'look south down the walkway: Horace blows the gate 6134 open ("Horace" 89f4)', do: 'look', at: [462.08, 80.5, 454.6], then: { until: `!!__world.world.get(0x89f4)?.s.played && !__world.world.runningStomps().some((r) => r.uid === 0x89f4)`, timeout: 30 }, expect: { played: [0x89f4] }, shot: true },
  // Back to where chapter 1 began: the arrival room door 79b2, still locked; trying it (p68 /
  // p69) runs Timer 8b79 / Relay 8c0c, enabled by Relay 8b7b, -> Level Transition 8b7a (1a "South
  // Spawn" 79b5, chapter 5:625).
  { id: 'r1b.exit', obj: 'through the gate to the arrival room: try the locked door 79b2 (Level Transition 8b7a, 1a)', do: 'use', uid: 0x79b2, goto: [430.2, 79.7, 485.2], transition: 0x8b7a, then: { level: '1a PrisonDeathRow' }, expect: { level: '1a PrisonDeathRow', checkpoint: true }, shot: true },
  // ---- r1a: 1a revisited (1b's 8b7a, "South Spawn" 79b5 in the basement) ----
  // The mail 11:0 reaches Level Transition Msg Handler 7a0c -> Relay 79e0, the revisit set-up:
  // fires and their damage Detectors along the corridors (Relays 79de / 79f0 / 79f6 / 7a02), the
  // gas chamber's door 50e7 opened and its trap Detector 5c1e destroyed (79ea / 7a0a), the door
  // 5125 shut and locked (79e4 / 79e5), the chair room's north door 4e47 shut and locked (8644 ->
  // 7a15 / 7a16), chapter 1's creatures and guards blown up (7a07), Detector 7a12 enabled (7a11:
  // the way out to 3a), Level Transition Msg Handler 8660 stores 31:0 for 3a.
  { id: 'r1a.arrive', obj: 'arrive in 1a from 1b at the South Spawn (the basement)', do: 'wait', until: 'true', timeout: 5, expect: { level: '1a PrisonDeathRow' }, shot: true },
  // The electric chair room (docs/playthrough.md "1a electric chair room"): Detector 79e6 ->
  // Relay 80d3: the door 5127 shuts (7a4a), "Camera" 80d2 (12:262); its end (Relay 7a4b) wakes
  // Horace 7a47 in the chair (HoraceKillPlayerBehavior: the Electric Shields and the five
  // generators' invulnerability go on and off with his charge, Relays 83ae / 8591), the two
  // corpses 7a3e / 7a41 get up, and Timer 8646 enables Timer 8398.
  { id: 'r1a.chair', obj: 'up the stairs into the electric chair room (Detector 79e6: "Camera" 80d2, Horace in the chair)', do: 'walk', to: [433.5, 88.7, 512.5], then: { cine: true, wait: 2 }, expect: { played: [0x80d2] }, shot: true },
  // The five generators (Breakables 8570 .. 8576, invulnerable while Horace charges) count Count
  // Down 8592 down; at zero Relays 8596 / 8649 unlock the chair switch 8588.
  { id: 'r1a.gen-8576', obj: 'break the generator 8576', do: 'break', from: [439.6, 88.7, 517.6], uids: [0x8576], then: { fight: 20 }, expect: { destroyed: [0x8576] } },
  { id: 'r1a.gen-8570', obj: 'break the generator 8570', do: 'break', from: [439.8, 88.7, 527.8], uids: [0x8570], then: { fight: 20 }, expect: { destroyed: [0x8570] } },
  { id: 'r1a.gen-8575', obj: 'break the generator 8575', do: 'break', from: [432, 88.7, 530.4], uids: [0x8575], then: { fight: 20 }, expect: { destroyed: [0x8575] } },
  { id: 'r1a.gen-8573', obj: 'break the generator 8573', do: 'break', from: [424.3, 88.7, 527.9], uids: [0x8573], then: { fight: 20 }, expect: { destroyed: [0x8573] } },
  { id: 'r1a.gen-8572', obj: 'break the generator 8572', do: 'break', from: [424.3, 88.7, 518], uids: [0x8572], then: { fight: 20 }, expect: { destroyed: [0x8572] }, shot: true },
  // The switch closed (p65 Off) starts Timer 8398 (2 s) -> "Camera" 8399 (12:251): Horace is
  // fried (Relay 839d BlowUp), 5127 opens (839b), Level Transition Remover 865d forgets 1b.
  { id: 'r1a.switch', obj: 'pull the chair switch 8588: Timer 8398 -> "Camera" 8399, Horace burns', do: 'use', uid: 0x8588, then: { cine: true, until: `!!__world.world.get(0x5127)?.s.open`, timeout: 15 }, expect: { played: [0x8399], open: [0x5127] }, shot: true },
  // Relay 8aae (the scene's end) enables Detectors 8aad (Hermes, "Hermes" 8ac9), 8502 and 8b07.
  { id: 'r1a.cp', obj: 'back out of the chair room: checkpoint (Detector 8b07: Autosave 8b08), Hermes (Detector 8aad)', do: 'walk', to: [435.3, 88.7, 494.8], then: { wait: 2, fight: 30 }, expect: { checkpoint: 0x8b08 } },
  // Out the way chapter 1 came in, backwards: the gas chamber's broken window, its door 50e7
  // (opened by the set-up), the sally port, the lobby, the lower west corridor, to the gate area
  // where Detector 7a12 -> Level Transition 7a13 (3a "North Spawn", chapter 5:628).
  { id: 'r1a.gas', obj: 'through the broken window into the gas chamber', do: 'walk', to: [417.5, 88.7, 447], then: { wait: 2, fight: 30 }, shot: true },
  { id: 'r1a.lobby', obj: 'west through the sally port into the lobby', do: 'walk', to: [395.7, 88.7, 488], then: { wait: 2, fight: 30 }, shot: true },
  { id: 'r1a.exit', obj: 'south down the lower west corridor to the gate: Detector 7a12 -> Level Transition 7a13 (3a)', do: 'walk', to: [421.6, 88.7, 562.6], max: 300, then: { level: '3a YardCellBlock' }, expect: { level: '3a YardCellBlock' }, shot: true },
  // ---- end of 7 Return to Prison ----
  // ---- 8a / 8b Bluff (block owned by the chapter 8 route) ----
  // 8a Bluff, arriving from 3a's revisit exit 2e93 at the SouthEast Spawn (1aa2) in the prison's
  // admissions yard. Read from the level's message graph and checked in the browser (docs/
  // playthrough.md "8 Bluff"). The dying guard 281d by the paddy wagon talks (Detector 1bbe /
  // 2b0a -> Relay 2823: Speech 2821 40:132, his BC 281e; the Slayer 2913 is released, Timer 2824)
  // and the script blows him up when the player comes on (Detector 2d3d / 1cb0 -> Relay 2d3b ->
  // Timer 2d07 BlowUp). Detector 2914 starts the yard ambush: Object Cloner 274d (six Slayers, two
  // at a time) and, through Relay 28da (also the guard's damage), Cloner 27ed (CartWheelers).
  { id: '8a.arrive', obj: 'arrive from 3a at the SouthEast Spawn', do: 'wait', until: 'true', timeout: 5, expect: { level: '8a Bluff' }, shot: true },
  { id: '8a.guard', obj: 'north into the yard: the dying guard by the paddy wagon talks (Detector 1bbe)', do: 'walk', to: [366.5, 97.7, 526], then: { wait: 4 } },
  // The paddy wagon: Detector 28fc (by the wagon) takes the invulnerability off its hit targets,
  // the engine box 1b80 (20 health, a hidden system-package Breakable) and the fuel can 25b3.
  // Broken, 1b80 plays "PaddyWagon" 1b7c (25b3: 2b01): the wagon rolls north and smashes the gate
  // (Door1 / Door2 25e4 / 25ef), its collision box SwitchBus 2a15 lands in the gateway; at its end
  // Relays 1da0 (Clamber Points 26e0 / 26e1 / 26e3 on the wagon enabled) and 28df (the ambush
  // cloners Off), 29db (the gate's blockers 29d3.. Off).
  // The refuge the level is built round: the guard house roof (103.6, 6 m over the yard). Its
  // east edge is Clamber Point 2288 (a box 8 m along z on the edge, top 103.7) and its south edge
  // 2d2c; a clamber allows 2.5..4.5 m from the feet to the ledge, so the way up is the crate 193a
  // (Pushable 7:457, 2 m tall) in the corner south of the alley: pulled west against the guard
  // house's line, pushed north up the alley under 2288, jumped onto (the first-person jump,
  // Player p215 10 m/s under p214 24.4: 2.05 m) and clambered from (4.0 m). On the roof Detector
  // 27fc (the top of 2288) switches the pit CartWheelers' Behavior Changers 27ee / 27f0 off,
  // 1cb0 starts the ambush (Relays 28da / 28dc) and kills the guard (2d3b), 28fd makes the
  // wagon's engine 1b80 and fuel can 25b3 vulnerable: it is shot from up there and "PaddyWagon"
  // turns the cloners Off (Relay 28df).
  { id: '8a.crate', obj: 'pull the crate 193a west, out of the corner (Pushable 7:457)', do: 'push', uid: 0x193a, stand: [413.45, 97.7, 521.3], rel: [-1.35, 0], dir: [-1, 0], key: 'KeyS', secs: 5, until: `__pt.center(0x193a)[0] < 412.85` },
  { id: '8a.crate2', obj: 'push it north up the alley under Clamber Point 2288', do: 'push', uid: 0x193a, stand: [412.64, 97.7, 519.9], rel: [0, -1.35], dir: [0, 1], secs: 30, until: `__pt.center(0x193a)[2] > 531.6` },
  { id: '8a.crate-jump', obj: 'jump onto the crate (first person: 2.05 m)', do: 'route', relTo: 0x193a, pts: [[-0.3, 97.7, -2.4], [-0.4, 99.65, 0]], jumpAt: [-0.3, -1.9, 0.3], timeout: 8 },
  { id: '8a.roof', obj: 'clamber from the crate onto the guard house roof (Clamber Point 2288, 4 m): Detectors 27fc / 1cb0 / 28fd', do: 'clamber', here: true, face: [[410.5, 104.2, 533]], shot: true },
  // On the roof the pit CartWheelers flee (27fc -> Relay 27f3 Disable -> Behavior Changer 27ee
  // with FleeBehavior 27ef enabled, 27f0 with KillEnemies 27f1 (the player as p3 target) disabled;
  // Timer 29e7 -> Relay 2806 hands them out; the yard grid 27fd.. does the reverse). The Slayers
  // (Object Cloner 274d, two at a time, and the placed 2756 by the alley) still shoot up at him:
  // they are fought from up there first.
  { id: '8a.wagon', obj: 'from the roof\'s north edge shoot the wagon\'s engine (1b80, 25 m): "PaddyWagon" sends it through the gate', do: 'break', from: [405.5, 103.63, 554.3], uids: [0x1b80], then: { wait: 6, fight: 20 }, expect: { destroyed: [0x1b80], played: [0x1b7c] }, shot: true },
  { id: '8a.roof-fight', obj: 'fight the yard\'s Slayers left from the roof before going down (the CartWheelers flee; the cloners are off)', do: 'arena', stand: [406.5, 103.63, 546], hold: 12, until: `!__pt.hostiles(30).filter((a) => ['chase', 'attack', 'shoot'].includes(a.st)).length`, timeout: 150 },
  { id: '8a.roof-down', obj: 'down off the roof\'s north edge into the yard (6 m: no fall damage under 6.5 m)', do: 'walk', to: [392, 97.7, 559.5], drop: 6.2, then: { fight: 30 } },
  // Over the wagon wedged in the gateway (Clamber Point 26e0, its east side) and off its north
  // end: Detector 2cf6 -> Timer 2d06 (3 s) -> Autosave 1e08.
  { id: '8a.wagon-climb', obj: 'climb onto the wagon in the gateway (Clamber Point 26e0)', do: 'clamber', from: [387.7, 94.7, 594], face: [[385.5, 99, 594]] },
  { id: '8a.gate', obj: 'off the wagon\'s north end: checkpoint (Detector 2cf6 -> Timer 2d06 -> Autosave 1e08)', do: 'walk', to: [385.5, 94.7, 607], drop: 4, expect: { checkpoint: 0x1e08 } },
  // East along the road: Detector 1d10 / 2a19 plays "Camera" 1d0e (45 s): the prison truck with
  // Hermes and a prisoner drives past and plunges into the creek; its end shows the prisoner
  // 23b9 (Relay 29fa).
  { id: '8a.truck', obj: 'east along the road: the truck scene ("Camera" 1d0e)', do: 'walk', to: [460, 94.5, 600], tol: 1.5, then: { cine: true, wait: 2 }, expect: { played: [0x1d0e] }, shot: true },
  // Detector 2cf8 -> Relay 1d4e (the Infernas 2534 / 2545 / 254d, the Burrowers 2cda / 1d50, the
  // fires) and Relay 2d01 (the Slayers 1d4a / 1d4c on their waypoints).
  { id: '8a.infernas', obj: 'south to the creek bank: Infernas, Burrowers and Slayers (Detector 2cf8)', do: 'walk', to: [454, 94.5, 566], tol: 1.5, then: { wait: 3, fight: 60 } },
  // The creek (3..3.5 m deep): water holds nobody up and deeper than 2 m the player drowns
  // (levels/water.ts). Down the bank to the west ledge at the water level, a running jump over the
  // 3 m channel at the south ford (z 540, Detector 2b2c), north along the east ledge under the
  // overhang to the rocks, up Clamber Points 25b1 and 2a3e onto the far bank's terraces.
  // Crossing the bank's planes (Detectors 2712..2715) sends the CartWheeler 2813 off the cliff to
  // Jimmy (26fb) by the gate 19b4, who kills it (Relay 2709 -> Timer 281c -> BlowUp).
  // The west bank's water-level rock at the ford (84.1) is drawn faces only for movers since the
  // collision trees (docs/game-logic.md §14.10: its model's tree has no nodes): nobody stands on
  // it. The crossing is a running jump from the bank top (87.5) over the channel onto the east
  // ledge (84.7), 3.8 m across and 2.7 m down; the cave wall behind the ledge stops the jump.
  { id: '8a.creek', obj: 'to the west bank top above the ford', do: 'walk', to: [460.5, 87.6, 539.5], tol: 0.6 },
  { id: '8a.ford', obj: 'a running jump from the bank top over the channel onto the east ledge (Detector 2b2c)', do: 'route', pts: [[463.3, 87.4, 539.5], [468.6, 84.7, 539.5]], jumpAt: [462.8, 539.5, 0.35], timeout: 10, shot: true },
  { id: '8a.ledge', obj: 'north along the east ledge under the overhang towards the rocks', do: 'walk', to: [486.9, 84.74, 584.4], tol: 1.2, drop: 4 },
  { id: '8a.rocks', obj: 'up the rocks (Clamber Points 25b1, 2a3e)', do: 'clamber', from: [491, 84.7, 593.4], face: [[491.2, 87.8, 591.5], [491.4, 90.2, 587.8]], stands: [null, [491.2, 87.2, 589.6]] },
  // Detector 1e1e: the Slayers 1e1c / 1e1a on their waypoints and three CartWheelers (Relay 232e
  // -> Timers -> Behavior Changers 2332..2334: JumpBehavior off the rocks).
  { id: '8a.bank', obj: 'onto the far bank (Detector 1e1e: Slayers and CartWheelers)', do: 'walk', to: [494, 92.2, 578], then: { wait: 2, fight: 60 } },
  // Detector 1d48 -> Relay 1e0c -> Autosave 1e0a; Relay 2345 (and Detectors 2346 / 2718 / 22cd ->
  // Relay 2341): the Burrowers 2d08..2d0b come up (Behavior Changers 233e.. JumpBehavior).
  { id: '8a.cp2', obj: 'east: checkpoint (Detector 1d48 -> Autosave 1e0a)', do: 'walk', to: [540, 96.5, 585], tol: 1.5, then: { fight: 40 }, expect: { checkpoint: 0x1e0a } },
  { id: '8a.path', obj: 'north-east up the path (Detectors 2718 / 22cd: Burrowers, the voices 22c3..)', do: 'walk', to: [569, 100.5, 612], tol: 1.5, then: { fight: 40 } },
  // The vision of the hanged men at the clearing: Detectors 271a / 271b (or a look through
  // Visiblity Message Filter 1d02 from 2719) -> Relay 22cc -> Screen Fader 1dac (Time Scale, blur,
  // the hanged men 1d18.. shown, the bodies 1d12.. hidden); Timer 1da8 ends it -> Relay 2716 ->
  // Relay 2cae: the Slayers 2caf..2cb2 come down (Waypoint, then KillEnemies), the first of the
  // Count Down chain 2c90 -> 2c01 -> ... (about 25 Slayers in waves on Ranged Targeting
  // Positions). The exit is never gated by them.
  { id: '8a.vision', obj: 'the clearing: the vision of the hanged men, then the Slayers come', do: 'walk', to: [604, 101.5, 630], tol: 1.5, then: { until: `!!__world.world.get(0x1da8)?.destroyed`, timeout: 40 }, expect: { destroyed: [0x1da8] }, shot: true },
  { id: '8a.slayers', obj: 'fight the first Slayer wave (Count Down 2c90)', do: 'arena', stand: [600, 101, 628], hold: 20, until: `!!__world.world.get(0x2c90)?.destroyed`, timeout: 240, shot: true },
  // The exit: a hole under the rock arch east (Detector 1b70, always enabled) -> Level Transition
  // 1d60 to 8b.
  { id: '8a.exit', obj: 'east to the cave mouth and down: Detector 1b70 -> Level Transition 1d60 to 8b', do: 'walk', to: [670.1, 95.3, 572.5], drop: 3.6, then: { level: '8b Bluff' }, expect: { level: '8b Bluff' }, shot: true },
  // 8b Bluff ("Caves to Lighthouse"), arriving from 8a at Player Spawn Point 1795 in the cave
  // under the bluff. Read from the level's message graph and checked in the browser (docs/
  // playthrough.md "8 Bluff"). Detector 170b: Jimmy (16fe) talks (Speech 18a7 / 18a6) and walks
  // off; Festers 1709 / 1b4d on their waypoints (Behavior Changers 1953 / 1b4e).
  { id: '8b.arrive', obj: 'arrive from 8a', do: 'wait', until: 'true', timeout: 5, expect: { level: '8b Bluff' }, shot: true },
  { id: '8b.jimmy', obj: 'south through the cave: Jimmy talks and walks off (Detector 170b)', do: 'walk', to: [236.3, 90.3, 319], tol: 0.3, then: { wait: 3 } },
  // Up two ledges (Clamber Points cf9 and 1802) into the upper cave: Detector 25f7 -> Autosave
  // 25f8; Detector 1787 wakes the Fester 1783 and the CartWheelers 1785 / 1786.
  { id: '8b.climb', obj: 'up the two ledges (Clamber Points cf9, 1802)', do: 'clamber', from: [192.2, 90.7, 255.8], face: [[194.6, 95, 255.4], [197.5, 99, 254]], stands: [null, [197.5, 95, 255.6]] },
  { id: '8b.cp1', obj: 'the upper cave: checkpoint (Detector 25f7 -> Autosave 25f8)', do: 'walk', to: [179.4, 98.3, 242], tol: 0.5, then: { wait: 2, fight: 30 }, expect: { checkpoint: 0x25f8 } },
  // Up through the hole in the floor of the telephone room (Clamber Points 11e4..11e6); its
  // stairs down to a store room whose way east is barred by a crate stack.
  { id: '8b.cave', obj: 'through the upper cave to the hole under the telephone room', do: 'walk', to: [153.6, 99.9, 178.6], tol: 0.8, then: { fight: 30 } },
  { id: '8b.hole', obj: 'up through the hole into the telephone room (Clamber Points 11e4..11e6)', do: 'clamber', from: [155.5, 100.8, 181.6], face: [[155.5, 105.5, 180]] },
  { id: '8b.store', obj: 'down the stairs into the store room', do: 'walk', to: [153.4, 98.9, 166.2], tol: 0.6, then: { wait: 2 } },
  // The store room's Tommy Gun rounds (Ammo Boxes 18b2..18b4) and Xombium 18b7, before the horde.
  { id: '8b.ammo', obj: 'the store room\'s ammunition', do: 'walk', to: [132.5, 98.9, 168], tol: 1, run: true, loot: 6 },
  // The crate 1d5e (10 health) breaks: Relay 18bf opens Portal 1196, shows the way east
  // (Visibility Togglers 1d7a / 1d7b) and starts a horde: the Slayer 18bb (Timer 2676), Object
  // Cloner 2698's Mainliners, the Slayer chain 2631.. (Count Downs 264a .. 265e -> Cloner 2660:
  // eleven Slayers).
  { id: '8b.barricade', obj: 'smash the crate that bars the way east (1d5e): the horde comes', do: 'break', from: [156.6, 98.9, 169.2], uids: [0x1d5e], expect: { destroyed: [0x1d5e] } },
  { id: '8b.horde', obj: 'fight the horde in the store room', do: 'arena', stand: [156.6, 98.9, 169.2], hold: 14, until: `!__pt.hostiles(25).filter((a) => a.st !== 'idle').length`, timeout: 360, shot: true },
  // Jimmy's room: the cave wall by the stove is held by the hidden targets 181f (50 health,
  // explosions only: Damage Resistance 2:662, type 3; vulnerable while a Pushable stands in
  // Detector 180a, filter 3) and 1929 (100 health, explosions only). Either one broken: Relay
  // 174e -> "Cavern Rubble" 1d86, the wall gone (Visibility Togglers 174d / 17cd, EdgeToggler
  // 1765), Jimmy's Behavior Changer 174f.
  { id: '8b.stove', obj: 'east to Jimmy\'s room by the stove', do: 'walk', to: [186.9, 97.7, 137], then: { wait: 4 } },
  // The explosive crate 2598 (breakSpawn 7:2494) into Detector 180a: it stands at 135 deg, so it
  // moves along its diagonals (props.ts: the grab takes the crate axis that points at it): pulled
  // north-west, pushed south-west, pulled north-west again against the stove (`rel`: each stand on
  // the crate's diagonal from where it is). Shot there, its blast breaks 181f and 1929: the wall
  // that shuts Jimmy in falls (the way east does not need it).
  { id: '8b.crate', obj: 'pull the explosive crate 2598 north-west', do: 'push', uid: 0x2598, stand: [187.69, 97.7, 132.92], rel: [-1.24, 1.24], dir: [-0.707, 0.707], key: 'KeyS', secs: 7, until: `__pt.center(0x2598)[2] > 135.2` },
  { id: '8b.crate2', obj: 'push it south-west towards the stove', do: 'push', uid: 0x2598, stand: [186.64, 97.7, 136.45], rel: [1.24, 1.24], dir: [-0.707, -0.707], secs: 5, until: `__pt.center(0x2598)[0] < 184.4` },
  { id: '8b.crate3', obj: 'pull it north-west into Detector 180a (181f vulnerable)', do: 'push', uid: 0x2598, stand: [182.95, 97.7, 135.23], rel: [-1.24, 1.24], dir: [-0.707, 0.707], key: 'KeyS', secs: 5, skipDone: true, until: `(() => { const s = __world.world.get(0x180a).s.inside; return !!s && s.size > 0; })()` },
  { id: '8b.crate3-again', obj: 'once more when the pull fell short (a loaded machine: run d8 moved it 0.35 m)', do: 'push', uid: 0x2598, stand: [182.95, 97.7, 135.23], rel: [-1.24, 1.24], dir: [-0.707, 0.707], key: 'KeyS', secs: 3, skipDone: true, until: `(() => { const s = __world.world.get(0x180a).s.inside; return !!s && s.size > 0; })()` },
  { id: '8b.blast', obj: 'shoot the crate: its blast breaks the cave wall ("Cavern Rubble")', do: 'break', from: [189.5, 97.7, 135.3], uids: [0x2598], then: { wait: 3 }, expect: { destroyed: [0x2598], played: [0x1d86] }, shot: true },
  // East along the cave: Detector 11fd -> Relay 1897 -> Autosave 1898; Burrowers (Detectors 1792 /
  // 1be8), Cloner 1bd3's CartWheelers; the ravine (Detector 1793 -> Relay 1794: the Slayers 16f4 /
  // 18ef, the Burrower 16f5); up Ladder d05 to the walkway: Detector 25f9 -> Autosave 25fa.
  // Jimmy (1738), freed: Relay 174e -> 1751 -> Behavior Changer 174f: SimpleConversation 1752
  // (walks up, line 40:20) -> WaypointBehavior 1753, which escorts the player (p8 [the Player],
  // a leg only while he is within p9 10 m, beckoning beyond p10 20 m) 1754 .. 1757 -> Simple-
  // Conversation 1758 (waits for him within 30 m, 40:21) -> WaypointBehavior 1759 175a .. 175c by
  // the ravine's ladder -> SimpleConversation 1760 (40:312) -> WaypointBehavior 189f straight to
  // Waypoint 1ea5 in Hermes' room (up Ladder d05; p3 2: he never fights on it). On the walkway
  // Detector 26b5 (filter 1) -> Instance Message Filter 26b6 (sender Jimmy) -> Relay 1ea3 -> 24e9:
  // Relay 1edf off, 24e8 on, so the room's scene is his "Camera" 1eb1 (76 s), not 1ed5.
  { id: '8b.jimmy-free', obj: 'Jimmy, freed, talks (SimpleConversation 1752)', do: 'wait', until: `[0x1753, 0x1758, 0x1759, 0x1760, 0x189f].includes(__actors.manager.get(0x1738)?.behavior?.uid)`, timeout: 90 },
  { id: '8b.jimmy-east', diag: allyDiag(0x1738), obj: 'follow Jimmy east through the broken wall (WaypointBehavior 1753)', do: 'follow', uid: 0x1738, until: `[0x1758, 0x1759, 0x1760, 0x189f].includes(__actors.manager.get(0x1738)?.behavior?.uid)`, timeout: 300, fight: true },
  { id: '8b.east', obj: 'east through the broken wall: checkpoint (Detector 11fd -> Autosave 1898)', do: 'walk', to: [241.2, 91.2, 141.5], then: { wait: 2, fight: 30 }, expect: { checkpoint: 0x1898 } },
  { id: '8b.jimmy-burrowers', diag: allyDiag(0x1738), obj: 'follow Jimmy on east and north (WaypointBehavior 1759: Burrowers, CartWheelers) to the ravine\'s mouth', do: 'follow', uid: 0x1738, until: `[0x175e, 0x175d, 0x175c].includes(__actors.manager.get(0x1738)?.waypointNow ?? 0) || [0x1760, 0x189f].includes(__actors.manager.get(0x1738)?.behavior?.uid)`, timeout: 600, fight: true },
  // The ravine (Detector 1793 at its mouth -> Relay 1794: the Slayers 16f4 / 18ef, the Burrower
  // 16f5) killed Jimmy when he walked in first: the player goes ahead (beyond the escort's p9 10 m
  // he waits) and clears it, then fetches him.
  { id: '8b.ravine', obj: 'ahead into the ravine and clear it (Detector 1793: Slayers 16f4 / 18ef, the Burrower 16f5)', do: 'arena', stand: [242, 89.7, 228], hold: 10, until: `![0x16f4, 0x16f5, 0x18ef].some((u) => __actors.manager.get(u)?.alive)`, timeout: 240 },
  { id: '8b.jimmy-ravine', diag: allyDiag(0x1738), obj: 'back to Jimmy and after him through the ravine to its ladder (175c, SimpleConversation 1760)', do: 'follow', uid: 0x1738, until: `[0x1760, 0x189f].includes(__actors.manager.get(0x1738)?.behavior?.uid)`, timeout: 400, fight: true, then: { until: `__actors.manager.get(0x1738)?.behavior?.uid === 0x189f`, timeout: 60 } },
  { id: '8b.ladder', obj: 'up Ladder d05 to the walkway', do: 'ladder', from: [289.2, 90.5, 245.3], face: [292, 93, 245.3], top: 103.5 },
  { id: '8b.cp3', obj: 'the walkway: checkpoint (Detector 25f9 -> Autosave 25fa)', do: 'walk', to: [305.5, 103.7, 223.2], tol: 0.4, expect: { checkpoint: 0x25fa } },
  { id: '8b.jimmy-walkway', diag: allyDiag(0x1738), obj: 'Jimmy up the ladder and along the walkway: Detector 26b5 sees him (Relay 24e8 enabled: his scene)', do: 'wait', until: `!!__world.world.get(0x24e8)?.enabled || !__actors.manager.get(0x1738)?.alive`, timeout: 120 },
  // Hermes' gas room: Detector 1eaf -> Relay 1efd -> Relay 1edf -> "Camera" 1ed5 (48 s; with
  // Jimmy alive and unhurt, "Camera" 1eb1, 76 s, through Relay 24e8). Its end (Relay 1ed7): the
  // gas on (Mechanism 1fa3, Volumetric Fogs, Damage Action Objects 24fc / 24da / 24db / 249c, one
  // per difficulty, 3.5..10 a second) and the room's breakables made vulnerable (Relay 25c4).
  { id: '8b.hermes', obj: 'into Hermes\' gas room (Jimmy alive: his "Camera" 1eb1, Hermes kills him, Behavior Changer 25d5 -> DeathBehavior 10:350; else "Camera" 1ed5)', do: 'walk', to: [322, 105.9, 219.8], tol: 0.4, then: { cine: true, wait: 2 }, shot: true },
  // The four gas valves: Switch -> Disarm (the rotation group's p64) -> its Mechanism turns 160 deg
  // and at rest sends p58 Off (props.ts mechArrivalOutput) -> Relays 1fa7 / 1fab / 1fad / 1faf ->
  // Count Down 1fa9: at zero the gas stops (Mechanism 1fa3 Off, the Damage Action Objects Off) and
  // Relay 1fd7 starts the Hermes phase (Cloner 2416, Detectors 2565 / 24d2 / 271a..271d enabled).
  { id: '8b.valve1', obj: 'close the gas valve 2159', do: 'use', uid: 0x2159, stand: [327, 105.9, 212.2], then: { wait: 2 } },
  { id: '8b.valve2', obj: 'close the gas valve 2157', do: 'use', uid: 0x2157, stand: [338, 105.9, 212.2], then: { wait: 2 } },
  { id: '8b.valve3', obj: 'close the gas valve 21cf', do: 'use', uid: 0x21cf, stand: [340.8, 105.9, 242.8], then: { wait: 2 } },
  { id: '8b.valve4', obj: 'close the gas valve 213d: the gas stops (Count Down 1fa9)', do: 'use', uid: 0x213d, stand: [318.8, 105.9, 243.1], then: { wait: 4 }, expect: { destroyed: [0x1fa9] } },
  // Hermes at the stove. Six spots each with a Hermes copy (Object Cloners 2411.., a gas jet 3:3251,
  // a lamp stand); the player blocks them: crates 2404 / 1f8d onto Detectors 2458 / 245e (filter
  // 3), the hanging lamps 250e.. shot down (Mechanisms 2509 / 24a0 / 24ae). Each block -> Relay 2718
  // -> 2716 -> Behavior Changer 20c5: every copy walks to Waypoint 20c3 at the stove. A copy there
  // (Detector 2565, filter 1) enables Relay 1f0d. Hermes takes no damage (p5, Damage Resistances
  // 2:779 type 5 / 2:656 type 14 at x0) but their p2 = 1 passes the force of fire and wind: a
  // Molotov's blast (Radius Damage 4:248, force 20..13) makes him react, and his HitReactBehavior
  // 10:1228 sends its p11, Triggered, to his links: 1f0d -> 2496 -> "Hermes" 1f0f (the gas into the
  // stove) -> Count Down 1f15 (2 -> 1) and Timer 1f13 (8 s: he comes out again, the door opens).
  // Closing the stove door 1e37 (p36: starts open; p65 Decrement) brings 1f15 to zero -> Relay
  // 26ae -> "Camera" 24e7, Timers 251c / 25da -> "Door" 24ff.
  { id: '8b.jet', obj: 'push the crate 2404 onto the gas jet by it (Detector 2458): the copies go to the stove', do: 'push', uid: 0x2404, stand: [329, 105.9, 224.35], rel: [0, 1.35], dir: [0, -1], secs: 8, until: `__pt.center(0x2404)[2] < 220.3` },
  // Pushed past it (the push stops a poll late): pulled back north over it.
  { id: '8b.jet-back', obj: 'pull the crate back onto the jet if it went past', do: 'push', uid: 0x2404, stand: [329, 105.9, 218], rel: [0, 1.3], dir: [0, 1], key: 'KeyS', secs: 6, skipDone: true, until: `__pt.center(0x2404)[2] > 219.45` },
  { id: '8b.lamps', obj: 'shoot down the hanging lamps over three more jets (2510 -> 250e -> Mechanism 2509; 24be -> 24a6; 250b -> Mechanism 24a0)', do: 'break', from: [333, 105.9, 228.6], uids: [0x2510, 0x24be, 0x250b], then: { wait: 2 }, expect: { destroyed: [0x2510, 0x24be, 0x250b] } },
  { id: '8b.molotov', obj: 'a Molotov at the Hermes copy by the stove: he reacts (Triggered -> Relay 1f0d -> "Hermes" 1f0f)', do: 'throw', select: '4:249', cls: 'Hermes', near: [340.6, 105.9, 229.5, 2], ready: `!!__world.world.get(0x1f0d)?.enabled`, from: [336, 105.9, 233], aimY: 1, until: `!!__world.world.get(0x1f0f)?.s.played`, timeout: 120, then: { until: `!!__world.world.get(0x1f13)?.s?.running || !!__world.world.get(0x1f0f)?.s.done`, timeout: 15 }, shot: true },
  { id: '8b.stove-door', obj: 'close the stove door 1e37 before Hermes gets out (Count Down 1f15 -> Relay 26ae)', do: 'use', uid: 0x1e37, stand: [341.8, 105.9, 228.4], look: [343.8, 106.6, 228.4], then: { until: `!!__world.world.get(0x24e7)?.s.played`, timeout: 20 }, expect: { played: [0x24e7] } },
  { id: '8b.hermes-end', obj: 'the end scene "Camera" 24e7 and "Door" 24ff', do: 'wait', until: `!!__world.world.get(0x24e7)?.s.played`, timeout: 30, then: { cine: true, wait: 8 } },
  // Up the ladder 1ec7 through the hatch: Detector 1f2f -> Level Transition 1798 (9 Lighthouse;
  // it carries Jimmy, 1738, when he is alive).
  { id: '8b.exit', obj: 'up the ladder to the hatch: Detector 1f2f -> Level Transition 1798 to 9 Lighthouse', do: 'ladder', from: [346.5, 105.9, 209.6], face: [346.5, 108, 210.5], top: 111.5, then: { level: '9 Lighthouse' }, expect: { level: '9 Lighthouse' }, shot: true },
  // ---- end of 8a / 8b Bluff ----
  // ---- 9 Lighthouse / 10 Docks (block owned by the chapter 9-10 route) ----
  // 9 Lighthouse, arriving from 8b at Player Spawn Point ca5 at the top of the cave ladder e90, in
  // the lighthouse's base. Read from the level's message graph and the companion's Behavior
  // Changer chain, and played in the browser (docs/playthrough.md "9 Lighthouse").
  { id: '9.arrive', obj: 'arrive from 8b at Player Spawn Point ca5 by the lighthouse', do: 'wait', until: 'true', timeout: 5, expect: { level: '9 Lighthouse' }, shot: true },
  // West out of the base (door 15c0): Detector e87 sends the Infernas bd3..bd5 on their circles
  // and starts their taunts (Timer e86); Detectors bd8 / 1a72 / 1a73 -> Relay e88: they follow
  // the player (FollowBehavior e84) for Timer e89's 12 s, then turn hostile and ignite.
  { id: '9.out', obj: 'west out of the lighthouse base: the Infernas circle and taunt', do: 'walk', to: [331, 112.2, 217], tol: 1, then: { wait: 14 }, shot: true },
  // Their deaths count Count Down c59 down; Count Down e8c (Timer e89 and Detectors bd9 / bda /
  // c62) has already sent the guard bc9 (Behavior Changer bcb) up to fight beside the player.
  { id: '9.infernas', obj: 'fight the three Infernas (Count Down c59)', do: 'arena', stand: [324, 112.2, 217], hold: 20, until: `__world.world.get(0xc59).s.count === 0`, timeout: 300, shot: true },
  // c59 -> Relay 174a -> Behavior Changer c5a: the guard talks, walks to the gate (Waypoint c63)
  // and talks there (dc2); Timer dc3 -> dc5: two more lines, then his escort dc8 back north to
  // Waypoint dc9, whose arrival destroys Relay 19e9 (else Detector 19e8 by the generator removes
  // him).
  { id: '9.meet', diag: allyDiag(0xbc9), obj: 'to the guard at the gate: he talks', do: 'walk', to: [311, 112.3, 151], tol: 2.5, then: { until: `__actors.manager.get(0xbc9)?.behavior?.uid === 0xdc8 || !!__world.world.get(0x19e9)?.destroyed`, timeout: 150 } },
  { id: '9.escort1', diag: allyDiag(0xbc9), obj: 'follow him back north (escort dc8 to Waypoint dc9)', do: 'follow', uid: 0xbc9, until: `!!__world.world.get(0x19e9)?.destroyed`, timeout: 150, fight: true },
  // dc5 -> Relay e15 -> e16 -> Behavior Changer e14: his escort dcb west (Waypoints dcd / dce);
  // Detectors c9e / e8e -> Relay c9f send the Infernas c9b..c9d on their talking walks; the last
  // walk's end (e29 p17) -> Relay e40: hostility, ignition (e41 Triggered) and the guard's fight.
  { id: '9.escort2', diag: allyDiag(0xbc9), obj: 'follow him west into the burial ground (Relay c9f)', do: 'follow', uid: 0xbc9, until: `__pt.msgs(600).includes(' c9f')`, timeout: 150, fight: true },
  { id: '9.infernas2', obj: 'fight the three Infernas of the burial ground (Count Down ddd)', do: 'arena', stand: [300, 112.5, 250], hold: 20, until: `__world.world.get(0xddd).s.count === 0`, timeout: 300, shot: true, expect: { actorAlive: [0xbc9] } },
  // ddd -> Relay e18 -> Behavior Changer dd3: escort dd5 to Waypoint dd7 by the burning truck;
  // Detector 173d -> Relay ddc -> Timer c92: "Truck" e76, the fires c80..c84, the Infernas c85 /
  // c89 / c8a out of the truck (Timers c8d / c90 / c8f).
  { id: '9.escort3', obj: 'follow him west to the truck (Detector 173d)', do: 'follow', uid: 0xbc9, until: `__pt.msgs(600).includes(' ddc')`, timeout: 200, fight: true },
  { id: '9.truck', obj: 'fight the Infernas from the truck (Count Down dde)', do: 'arena', stand: [238, 112.3, 292], hold: 18, until: `__world.world.get(0xdde).s.count === 0`, timeout: 300, shot: true, expect: { actorAlive: [0xbc9] } },
  // dde -> Relay e6b -> Behavior Changer e79 -> e49 -> e4a -> ddf: escort de0 to Waypoint de3
  // by the generator yard; Detector 15b0 starts Object Cloner 158a: CartWheelers leap out of the
  // pit (JumpBehavior 16a1), then Cloner 1b62 without end until the fence burns.
  { id: '9.yard', obj: 'follow him to the generator yard', do: 'follow', uid: 0xbc9, until: `(() => { const a = __actors.manager.get(0xbc9); return !!a && Math.hypot(a.position.x - 153.7, a.position.z - 234.3) < 5; })()`, timeout: 200, fight: true },
  { id: '9.yard-fight', obj: 'the pit\'s CartWheelers (Object Cloners 158a / 1b62)', do: 'arena', stand: [152, 112.2, 232], hold: 14, until: `!!__actors.director.cloners?.get(0x158a) && (__actors.director.cloners.get(0x158a).remaining ?? 0) <= 0 && !__pt.hostiles(20).some((h) => ['chase', 'attack'].includes(h.st))`, timeout: 120, expect: { actorAlive: [0xbc9] } },
  // The fence round the generator: the searchlight 1376 on the tower (ladder 1378, door 1379)
  // turned onto the fuel tank lights Detector 18c6 (filter 4) -> Relay 13a8: the barrels burn
  // (Fires 13a9.., Timers 13f1..), Timer 13af: the fence 13a6 hidden, its nav edge opened
  // (EdgeToggler 1b68), the cloners stopped (Relay 15b2).
  { id: '9.tower', obj: 'up the searchlight tower (ladder 1378)', do: 'ladder', from: [135.1, 112.1, 240.2], face: [133.5, 113.5, 240.2], top: 120.5 },
  { id: '9.searchlight', obj: 'turn the searchlight 1376 onto the fuel tank: the barrels burn the fence away', do: 'searchlight', uid: 0x1376, from: [140.8, 121.55, 237.3], at: [138, 113.5, 220.1], until: `__fx.effects.fires.some((f) => f.uid === 0x13ab && f.lit)`, shot: true },
  { id: '9.tower-down', obj: 'down the tower ladder', do: 'ladderDown', uid: 0x1378, from: [133.8, 121.55, 241.2], face: [134.04, 121, 240.2], bottom: 112.6 },
  // The generator's switch 1429: the lights (Relay 1568), Relay 1025 (Count Down 1044 one step
  // nearer unlocking the lamp's crank), Detector 19a1 (checkpoint 199e, on the way east out of the yard) enabled.
  { id: '9.generator', obj: 'start the generator (Switch 1429)', do: 'use', uid: 0x1429, then: { wait: 3 }, shot: true },
  // Back out: the guard's line (e7b) and escort de5 to Waypoint de9 (Relay 1747); Detectors bc1 /
  // 174b -> Relay e57: "Inferna 1" bc2 and its four Infernas; their deaths (Count Down c9a) ->
  // Relay e77 -> e53 -> Behavior Changer dea: his escort dec south to Waypoint def, then e00
  // back north to Waypoint e02 by the lighthouse.
  { id: '9.east', obj: 'out of the yard after the guard: "Inferna 1"', do: 'follow', uid: 0xbc9, until: `!!__world.world.get(0xbc2)?.s.played`, timeout: 200, fight: true, expect: { checkpoint: 0x199e } },
  { id: '9.inferna1', obj: 'fight the four Infernas (Count Down c9a)', do: 'arena', stand: [195, 112.5, 205], hold: 18, until: `__world.world.get(0xc9a).s.count === 0`, timeout: 300, shot: true, expect: { actorAlive: [0xbc9] } },
  { id: '9.south', obj: 'follow him south (escort dec to Waypoint def)', do: 'follow', uid: 0xbc9, until: `(() => { const a = __actors.manager.get(0xbc9); return !!a && (a.behavior?.uid === 0xe00 || a.behavior?.uid === 0xe01); })()`, timeout: 300, fight: true },
  { id: '9.back', obj: 'follow him back to the lighthouse (escort e00 to Waypoint e02)', do: 'follow', uid: 0xbc9, until: `__actors.manager.get(0xbc9)?.behavior?.uid === 0xe01`, timeout: 300, fight: true },
  // The lighthouse: door 15bf, ladder 11 and the stairs to the room under the lamp. Its three
  // wedges (Breakables 1029 / 1045 / 1046, broken through the hidden targets 1919..191b) count
  // Count Down 1043 down -> 1044 unlocks the crank 9e1; pushed, it stops and fires p55 -> Relay
  // 1027: the lamp turns (Mechanisms 9db..9e7), Detector cab (the gate) and the guard's way out
  // (Behavior Changer e03).
  { id: '9.base', obj: 'back into the base', do: 'walk', to: [344.8, 112.1, 211.2], tol: 0.6 },
  { id: '9.door', obj: 'open the door to the ladder room (15bf)', do: 'use', uid: 0x15bf, stand: [346, 112.1, 216.3] },
  { id: '9.ladder', obj: 'up the ladder 11', do: 'ladder', from: [350.9, 112.1, 220.25], face: [352.5, 113.5, 220.25], top: 118 },
  { id: '9.stairs', obj: 'up the stairs to the lamp machinery', do: 'walk', to: [347.6, 136.1, 216.8], tol: 0.5 },
  { id: '9.wedges', obj: 'shoot the lamp\'s three wedges (Count Down 1043)', do: 'break', from: [347.74, 136.08, 217.16], uids: [0x1919, 0x191a, 0x191b], expect: { destroyed: [0x1029, 0x1045, 0x1046] }, shot: true },
  // The stand is south of the lamp housing 9dc's leaf box (z >= 216), which the view ray to the
  // crank crossed from the old stand (docs/game-logic.md §14.10): the grab missed.
  { id: '9.crank', obj: 'push the crank 9e1: the lamp turns', do: 'push', uid: 0x9e1, stand: [350.6, 136.1, 215.6], dir: [1, 0], secs: 4, until: `!!__world.world.get(0xcab)?.enabled`, shot: true },
  // Up into the lamp room: Detector 132b -> Relay 1326 -> the Reputation Points Message Filters
  // 1323 / 1324 / 1325 (above 70 / -90..70 / -90 and below) pick the vision's line (131d / 131f /
  // 1321), then she is gone (Relay 132c).
  { id: '9.lamp', obj: 'up into the lamp room', do: 'ladder', from: [345.5, 136.1, 216.3], face: [345.5, 137.5, 218], top: 140 },
  { id: '9.vision', obj: 'across the lamp room: the vision (by reputation)', do: 'walk', to: [351.5, 141, 218.5], tol: 0.8, then: { until: `!__actors.manager.get(0x131c)`, timeout: 40 }, expect: { gone: [0x131c] }, shot: true },
  { id: '9.lamp-down', obj: 'down from the lamp room', do: 'ladderDown', uid: 0x9da, from: [346.2, 141.03, 218.2], face: [345.5, 140, 217.46], bottom: 136.5 },
  { id: '9.stairs-down', obj: 'down the stairs', do: 'walk', to: [352.9, 118.1, 218.8], tol: 0.6 },
  { id: '9.ladder-down', obj: 'down the ladder 11', do: 'ladderDown', uid: 0x11, from: [352.7, 118.08, 218.6], face: [352, 117, 220.25], bottom: 112.6 },
  // Straight off the ladder's foot first: the planner's first leg from there (round the ladder's
  // collision box, docs/game-logic.md §14.10) could lead into the ladder, which mounted it again
  // (runs r2 / r7: the walk ended on the floor above).
  { id: '9.ladder-off', obj: 'step off the ladder\'s foot', do: 'route', pts: [[350.8, 112.1, 218.9]], timeout: 6 },
  { id: '9.base-door', obj: 'to the door of the ladder room', do: 'walk', to: [348.5, 112.1, 217.6], tol: 0.4, loot: 6 },
  { id: '9.outside', obj: 'out of the base to the guard', do: 'walk', to: [330.5, 112.5, 218], tol: 1.5 },
  // e03 -> his line and escort e05 to Waypoints e07 / e08 by the gate; e08 -> Relay 19e7 enables
  // Level Transition ca6. Detector cab on the way -> "Horace" cad (Horace blows the gate open)
  // and the mail 10:1 (Level Transition Msg Handler 19ea); its end -> Behavior Changer e09.
  { id: '9.gate', obj: 'follow him to the gate (Waypoint e08 enables Level Transition ca6)', do: 'follow', uid: 0xbc9, until: `!!__world.world.get(0xca6)?.enabled`, timeout: 200, fight: true },
  // Detector cab (player filter, an 18 x 1 m slab across the road at the gate, enabled by the
  // lamp) plays "Horace": the follow can end 6 m short of it, so walk into it.
  { id: '9.cab', obj: 'up to the gate (Detector cab)', do: 'walk', to: [305.3, 112.3, 147.9], tol: 0.6 },
  { id: '9.horace', obj: 'Horace blows the gate ("Horace" cad)', do: 'wait', until: `!!__world.world.get(0xcad)?.s.played && !__world.world.runningStomps().some((r) => r.uid === 0xcad)`, timeout: 240, expect: { played: [0xcad] }, shot: true },
  // Detector ca7 -> Level Transition ca6 (no spawn name: 10's Player Spawn Point 86d from 9) carries
  // the guard (p7: bc9) to 10's Companion Spawn Point 908.
  { id: '9.exit', obj: 'through the gate: Detector ca7 -> Level Transition ca6 to 10 Docks', do: 'walk', to: [318.9, 112.3, 145.9], tol: 0.8, then: { level: '10 Docks' }, expect: { level: '10 Docks' }, shot: true },
  // 10 Docks, arriving from 9 at Player Spawn Point 86d with the guard at Companion Spawn Point
  // 908 (Timer 1244 -> Behavior Changer 7b9: his escort 7ba). The mail 10:1 makes Relay 1246
  // remove Timer 1243 (the start without him).
  { id: '10.arrive', obj: 'arrive from 9 with the guard', do: 'wait', until: `__actors.manager.get(0x7b8)?.behavior?.kind === 'waypoint'`, timeout: 20, expect: { level: '10 Docks' }, shot: true },
  // Detector 94e -> Relay b50 -> "Inferna 1" a29; Screen Fader b52 -> the Infernas 7f0 / 7f1 woken
  // and lit (b53 Triggered); their deaths (Count Down 90b) -> Behavior Changer 90d: his line and
  // escort 90f east along the road to Waypoint 7cf.
  { id: '10.follow', diag: allyDiag(0x7b8), obj: 'follow the guard: "Inferna 1"', do: 'follow', uid: 0x7b8, until: `!!__world.world.get(0xa29)?.s.played`, timeout: 120, fight: true },
  { id: '10.infernas', obj: 'fight the two Infernas (Count Down 90b)', do: 'arena', stand: [165, 111.7, 392], hold: 30, until: `__world.world.get(0x90b).s.count === 0`, timeout: 300, shot: true },
  // On the way: Detector 7ec (Slayers 602 / 604, the Burrower dac), d31 (Object Cloners dbe / dc5,
  // the Slayers 61e / 61f). Waypoint 7cf (and Detector 3dc / Timer 112f) -> Count Down 112c ->
  // Relay 924: the creatures there walk off and are removed (Waypoints p0 12), the Infernas 7da /
  // 7dd talk and ignite (Behavior Changers 910 / 91b / 925), the fires on both ends of the pipe
  // yard are lit (Relay 7d9).
  { id: '10.road', diag: allyDiag(0x7b8), obj: 'follow him east to the pipe yard (Relay 924)', do: 'follow', uid: 0x7b8, until: `__pt.msgs(600).includes(' 924')`, timeout: 400, fight: true },
  { id: '10.pipe-infernas', obj: 'fight the two Infernas in the pipe yard (Count Down 929)', do: 'arena', stand: [265, 98.7, 277], hold: 12, preyDy: 3, until: `__world.world.get(0x929).s.count === 0`, timeout: 300, shot: true },
  // Trapped between the fires: the valves 357 / 35a (hidden Breakables) shot: Timer 365 raises
  // the water (Mechanism 341) and counts Count Down 394 down; the crate 318 pushed into Detector
  // 32e (filter 3) counts it down too -> Mechanism 32d raises the water by the fires; its slide's
  // arrival (p56 BlowUp) -> Relay 92e: the fires out (Timer 34c), Detector 124c gone, the
  // Mainliners of Object Cloner cf8, the guard's escort 92f north.
  { id: '10.machine-up', obj: 'onto the pump housing over the rail (Clamber Point 110b)', do: 'clamber', from: [261.6, 98.6, 287.4], face: [[260.6, 103.2, 287.3]] },
  { id: '10.crate-room', obj: 'down into the pump room behind it', do: 'route', pts: [[259.5, 98.6, 285.5]], timeout: 10 },
  { id: '10.crate-west', obj: 'push the crate 318 west', do: 'push', uid: 0x318, stand: [259.4, 98.6, 281.5], dir: [-1, 0], secs: 5, until: `__pt.center(0x318)[0] < 254.7` },
  { id: '10.crate-south', obj: 'push it south into Detector 32e', do: 'push', uid: 0x318, stand: [254.6, 98.6, 283.4], dir: [0, -1], secs: 5, until: `(__world.world.get(0x32e).s.inside?.size ?? 0) > 0` },
  { id: '10.valves', obj: 'shoot the two pipe valves (Count Down 394 at zero: Mechanism 32d)', do: 'break', from: [254.5, 98.6, 282.5], uids: [0x357, 0x35a], until: `__world.world.get(0x394).s.count === 0`, expect: { destroyed: [0x357, 0x35a] }, shot: true },
  // Clamber Point 38f's template (2:850) allows 3.5 m of height and its top is 4.4 m over the pump
  // room floor: from inside only 110b (2:455, 4.5 m) takes, stood at x 260.8 facing north (the
  // old stand at x 260 passed its side test by centimetres; run r12 failed it three times).
  { id: '10.climb-out', obj: 'back onto the pump housing (Clamber Point 110b)', do: 'clamber', from: [260.8, 98.6, 285.3], face: [[260.7, 103.2, 288]] },
  { id: '10.corridor', obj: 'down to the corridor', do: 'route', pts: [[262.3, 98.6, 287.6], [264, 98.6, 284]], timeout: 10 },
  { id: '10.water', obj: 'the water rises: the fire by the pipes goes out', do: 'wait', until: `!!__world.world.get(0x124c)?.destroyed`, timeout: 60, shot: true },
  { id: '10.mainliners', obj: 'fight the Mainliners (Object Cloner cf8, Count Down 1372)', do: 'arena', stand: [265, 98.6, 270], hold: 12, preyDy: 3, until: `__world.world.get(0x1372).s.count === 0 && (__actors.director.cloners?.get(0xcf8)?.remaining ?? 0) <= 0`, timeout: 200 },
  // His escort 92f / 933 north to Waypoint 934 by the broken road -> Relay b5d: "StompTruck" c80
  // (the truck burns), the Infernas 881 / 622 / 623 (Count Downs 882 / 1137); then Timer 1132
  // enables Detectors a68 / 137a: "Camera" 883 and "Bus" 884 (the bus falls across the gap,
  // Clamber Point 13a0 enabled).
  { id: '10.north', diag: allyDiag(0x7b8), obj: 'follow him north to the broken road ("StompTruck")', do: 'follow', uid: 0x7b8, until: `!!__world.world.get(0xc80)?.s.played`, timeout: 300, fight: true },
  { id: '10.truck-infernas', obj: 'fight the truck\'s Infernas (Count Down 1137)', do: 'arena', stand: [240, 97.2, 180], hold: 14, until: `__world.world.get(0x1137).s.count === 0`, timeout: 300, shot: true },
  { id: '10.bus', obj: 'to the edge of the gap: "Camera" 883, the bus falls across', do: 'walk', to: [244, 97.2, 176.4], tol: 0.8, then: { until: `!!__world.world.get(0x884)?.s.played && !__world.world.runningStomps().some((r) => r.uid === 0x884)`, timeout: 90 }, expect: { played: [0x883, 0x884] }, shot: true },
  { id: '10.bus-climb', obj: 'climb onto the bus (Clamber Point 13a0)', do: 'clamber', from: [236.2, 97.2, 174.5], face: [[234.9, 99.8, 173.9]] },
  // Across: Detector 62a: the Slayers f91 / f93 / 634 / 138d (Count Downs f97 / fbc / fab), the
  // guard's "Ernesto" scene (STOMP 1153) and his escort on east (114c .. 1258) to Waypoint 947.
  { id: '10.across', obj: 'across the bus (Detector 62a: Slayers)', do: 'walk', to: [237.5, 97.5, 153], tol: 1.5, drop: 3 },
  // `sea`: a Slayer knocked into the gap (its bed 84.5) is shot from the edge, not followed down:
  // run r10 followed one in and was stranded there (no way back up, invulnerable after a retry).
  { id: '10.slayers', obj: 'fight the Slayers past the bus', do: 'arena', stand: [237.5, 97.5, 153], hold: 25, sea: [95, [237.5, 97.5, 153]], until: `[0x634, 0xf91, 0xf93, 0x138d].every((u) => !__actors.manager.get(u)?.alive)`, timeout: 300, shot: true },
  { id: '10.east', diag: allyDiag(0x7b8), obj: 'follow him east to the burning road (Waypoint 947 -> Relay 949)', do: 'follow', uid: 0x7b8, until: `__pt.msgs(600).includes(' 949')`, timeout: 400, fight: true },
  // Waypoint 947: the fire across the road (Fires 44b.., Detectors d12 / 108f: 200 fire), the
  // Infernas d18 / d19 / 13f1..13f3 (Count Down 1256) -> Behavior Changer 1255: his farewell and
  // escort 945 to Waypoint 948 (Timer 10dd: +20 reputation), 10e2 removes him.
  { id: '10.road-east', obj: 'east along the road to the burning gate', do: 'walk', to: [328, 98.3, 127], tol: 1.5, run: true },
  { id: '10.road-gate', obj: 'on to the burning gate', do: 'walk', to: [372, 97.7, 126], tol: 1.5, run: true },
  { id: '10.gate-infernas', obj: 'fight the five Infernas at the gate (Count Down 1256)', do: 'arena', stand: [374, 97.7, 127], hold: 10, preyDy: 3, until: `__world.world.get(0x1256).s.count === 0`, timeout: 300, shot: true },
  { id: '10.farewell', diag: allyDiag(0x7b8), obj: 'the guard goes back to the town (Waypoint 948: +20 reputation)', do: 'follow', uid: 0x7b8, until: `__pt.msgs(600).includes(' 10dd') || !__actors.manager.get(0x7b8)`, timeout: 120, fight: true },
  // North-east round the fire: Detector 13e1 -> Autosave d29; Detector b01 -> "Crane Arm" b00 (the
  // crane swings its arm over the gap to the dock); Detector b20 -> "Camera" b7d (Killjoy), whose
  // end opens the gate c2a (Relay 1226).
  { id: '10.north-east', obj: 'north-east past the fire', do: 'walk', to: [402, 97.7, 166], tol: 1.5 },
  // (Detectors b01 and 13e1 are 1 m slabs across the road at z 188.7..189.7 and 195.3..196.3: the
  // walk ends past both. With 1.5 m of tolerance it used to stop short of 13e1, and d29 came only
  // on the next step.)
  { id: '10.cp', obj: 'on north: checkpoint (Detector 13e1 -> Autosave d29), "Crane Arm"', do: 'walk', to: [414, 97.7, 196], tol: 0.8, expect: { checkpoint: 0xd29, played: [0xb00] } },
  // (Past Detector b20, a slab across the road at x 430.5..431.5: the old point, 1.4 m on, lay where
  // the planner had no cell before the gate c2a opens, "1.31 m short", and read as a miss in
  // every run although "Camera" b7d played.)
  { id: '10.killjoy', obj: 'Killjoy ("Camera" b7d): the gate c2a opens', do: 'walk', to: [432, 97.7, 213], tol: 0.6, then: { cine: true, wait: 2 }, expect: { played: [0xb7d] }, shot: true },
  // The dock: Detector 121e -> Relay a87 sends Enable through the Reputation Points Message
  // Filters a86 / a88 / a89 (above 70 / -90..70 / -90 and below): only that reputation's relays
  // pass from here on. Detector 83b -> Relay a8a -> Timer a8b -> a47 -> "Camera" a6f / a70 / a71,
  // whose end plays "Camera" 1084: the dark self a48 wakes, Object Cloner b32 sends Mainliners.
  { id: '10.gate', obj: 'through the gate (Detector 121e: the ending is chosen)', do: 'walk', to: [452, 97.7, 221], tol: 1 },
  { id: '10.dock', obj: 'onto the dock (Detector 83b): the dark self', do: 'walk', noWater: true, saveRounds: true, to: [469.7, 92, 254], tol: 1.5, drop: 4, then: { cine: true, wait: 2 }, shot: true },
  // a48's death sends its p29 (19) to Relay a49: the cloner off (b33), Count Down 12b5 -> Timer
  // 12a5 enables Detectors b43 / 1419; standing in them human (Insanity Mode Message Filter b44,
  // p1 1) and looking at Visiblity Message Filter b45 -> Relay 12b1 -> a76: the next scene, then
  // "Camera" 1083: a46 and Object Cloner b2d's CartWheelers. Its death (p29 19 -> a8c) and theirs
  // -> Count Down 12b7 -> Timer 12a7: Detectors b47 / 141a with b48 / b49 -> Relay 12b0 -> a7e: the
  // last scene, "Camera" 1082, which wakes the Black One 822.
  { id: '10.dark1', obj: 'fight the dark self a48 and the Mainliners (Count Down 12b5)', do: 'arena', noWater: true, saveRounds: true, sea: [91, [470, 92.1, 260]], drop: 4, stand: [470, 91.9, 260], hold: 9, preyDy: 1, prey: [0xa48], until: `!__actors.manager.get(0xa48)?.alive && __world.world.get(0x12b5).s.count === 0`, timeout: 400, shot: true },
  // Knocked off the dock into the sea (a Mainliner's hold, a blow): the sea holds the player but
  // nothing leads back up the 1.8 m dock edge (Clamber Points ee0 / ee7 / ee8 are out of reach from
  // the water): back onto the dock (logged; open in docs/playthrough.md "10 Docks").
  { id: '10.sea1', obj: 'back onto the dock if knocked into the sea', do: 'teleport', unless: `__player.position.y > 91`, to: [470, 92.1, 260], why: 'knocked into the sea by the dock: no way back up' },
  { id: '10.vision1-stand', obj: 'into Detector b43 on the dock', do: 'walk', noWater: true, saveRounds: true, drop: 4, to: [468, 91.9, 261], tol: 1.2 },
  { id: '10.vision1', obj: 'human, in Detector b43, look at the filter b45: the next scene', do: 'vision', noWater: true, saveRounds: true, drop: 4, sea: [91, [470, 92.1, 260]], stand: [468, 91.9, 261], at: [476.1, 94, 255.8], ready: `!!__world.world.get(0xb43)?.enabled`, until: `!!__world.world.get(0x1083)?.s.played`, timeout: 60, expect: { played: [0x1083] } },
  { id: '10.dark2', obj: 'fight the dark self a46 and the CartWheelers (Count Down 12b7)', do: 'arena', noWater: true, saveRounds: true, sea: [91, [470, 92.1, 260]], drop: 4, stand: [470, 91.9, 260], hold: 9, preyDy: 1, prey: [0xa46], until: `!__actors.manager.get(0xa46)?.alive && __world.world.get(0x12b7).s.count === 0`, timeout: 400, shot: true },
  { id: '10.sea2', obj: 'back onto the dock if knocked into the sea', do: 'teleport', unless: `__player.position.y > 91`, to: [470, 92.1, 260], why: 'knocked into the sea by the dock: no way back up' },
  { id: '10.vision2-stand', obj: 'into Detector b47 on the dock', do: 'walk', noWater: true, saveRounds: true, drop: 4, to: [466, 91.9, 260], tol: 1.2 },
  { id: '10.vision2', obj: 'human, in Detector b47, look at the filter b49: the Black Ones wake', do: 'vision', noWater: true, saveRounds: true, drop: 4, sea: [91, [470, 92.1, 260]], stand: [466, 91.9, 260], at: [439.8, 94.6, 260.5], ready: `!!__world.world.get(0xb47)?.enabled`, until: `!!__world.world.get(0x1082)?.s.played`, timeout: 60, expect: { played: [0x1082] } },
  // The Black Ones (#7f4 / #820 / #821 / #822, specials/black-one.ts): one is up at a time; its heart
  // breaks three times (stages); the last death -> Relay b25 -> Timer 12a8 -> 12c8 -> the enabled
  // ending relay (b3d / b3c / b3b) -> Movie Player b39 / b26 / b3a -> STOMP 108d -> the boat
  // sequence 1089 / 108a / 108b -> the picture (GUI Launcher 123b / 123e / 123f) -> Relay 1242 ->
  // Timer 1241 -> Relay 13b3 -> GUI Launcher 123c: Game Finished (docs/campaign.md §5).
  { id: '10.boss', obj: 'the Black Ones: shoot the heart of the one that is up', do: 'boss', noWater: true, sea: [91, [459, 92.1, 261]], uids: [0x7f4, 0x820, 0x821, 0x822], until: `[0x7f4, 0x820, 0x821, 0x822].some((u) => !!__specials.get(u)?.info?.done)`, timeout: 400, shot: true },
  { id: '10.ending', obj: 'the ending: movie, boat scene, picture, Game Finished', do: 'wait', strip: 6, until: `!!window.__campaign?.state?.ending || (!!window.__menu && __menu.frontend.stack.some((t) => t.screen.id === 'gameFinished'))`, timeout: 300, shot: true },
  { id: '10.finish', obj: 'Game Finished (Save Settings), then the credits', do: 'finish', timeout: 60, endings: { good: [0xb39, 0x1089, 0x123b], neutral: [0xb26, 0x108a, 0x123e], evil: [0xb3a, 0x108b, 0x123f] }, bonus: [0x13b2] },
  // ---- end of 9 Lighthouse / 10 Docks ----
  // ---- 0 Prelude Docks (block owned by the Prelude route) ----
  // The Prelude is New Game's level once the game was finished (Main Menu p18 while engine flag
  // 0x400 is set; --level 0 boots through the menus with the profile's unlock). Timer 11c3 starts
  // "Camera" 10e9 (41.7 s: the PoliceBoat brings Torque in) and forbids the insanity (Allow Player
  // Insanity Object 1143 p5). Its end (Relay 1114) starts the dock scene: Torque locked in the
  // holding pen (x 451..460, z 218..232; gates 1185 / 1186 locked) with five inmates (ddd / de0 /
  // de3 on their own team 10:301, dcb / dda prisoners 10:212), the guards 10e4..10e7 outside the
  // west fence, the Archive page "The Island" (11fa), the move hints.
  { id: '0.arrive', obj: 'New Game: the boat brings Torque to the docks ("Camera" 10e9); the dock scene starts', do: 'wait', until: `!!__world.world.get(0x10e9)?.s.played && __pt.msgs(600).includes(' 10e9 1114')`, timeout: 90, expect: { level: '0 Prelude Docks', played: [0x10e9] }, shot: true },
  // Timer 12d9 / 12dc open Detector 12da by the pen's south-east corner for 4 s (Timer 12e3) while a
  // gull (Ambient Creature 12d3) comes over: a player standing there sees "Hat!!" 12ea knock the
  // inmate's hat off (Attachment 12e8) and the inmates talk on at once (Sound 12db -> Relay 12e6).
  { id: '0.hat', obj: 'step to the pen\'s south-east corner as the gull comes: Detector 12da -> "Hat!!" 12ea', do: 'walk', to: [458.8, 97.7, 230.8], tol: 0.35, then: { until: `!!__world.world.get(0x12ea)?.s.played`, timeout: 40 }, expect: { played: [0x12ea] }, shot: true },
  // The inmates' talk (Timers 129e..12ad) ends in Behavior Changers 112f / 1131 / 1133: de3 / de0 /
  // ddd draw their weapons (Melee Weapon 4:766) (SpawnWeapons 153, clip 2:219) and go for Torque (KillEnemies
  // dd8 / de2 / 12a9, the player's team among the enemies); dcb / dda flee to the pen's corners
  // (FleeBehaviors ddf / de5, Flee Positions 11b8..11bb); Relay 1235 fills the insanity meter (Toggle 1141 p3) and starts Timer 119b.
  // (Ends as Timer 12a4 starts 12a5, 1.5 s before Behavior Changer 112f: the step's own probes take
  // a few seconds, and the blows start at once.)
  { id: '0.talk', obj: 'the inmates talk until they are about to turn on Torque (Timer 12a5 -> Behavior Changer 112f)', do: 'wait', until: `__pt.msgs(600).split('; ').some((m) => m.split(' ')[3] === '12a5')`, timeout: 150, shot: true },
  // Medium: 100 health, the Health Threshold Trigger 11e5 (120) never fires, so Timer 119b (17 s)
  // brings the transformation (Relay 1173 -> Screen Fader 1174 -> Timer 12c2 -> Toggle 1141 On;
  // "Shoe Left" 12c4, "Hat!!" 12e9) and the attack hints (Help Popups 11fb / 11fc). Three weapons
  // (8 a blow, KillMelee 10:578 waits 0.5..1.5 s between blows) kill a Torque who stands still
  // just before it: he keeps away from them round the pen.
  { id: '0.beating', obj: 'beaten by the three inmates: keep away from them round the pen until the insanity takes him (Timer 119b)', do: 'evade', pts: [[455, 97.7, 220], [460.5, 97.7, 220], [460.5, 97.7, 230.5], [455, 97.7, 230.5]], until: `__insanity.model.form === 'creature'`, timeout: 45, shot: true },
  // Count Down de6 counts the three attackers' deaths; then Count Down 1138 (Timer 1137 5 s later, or
  // dcb and dda dead: Count Down 1136) enables Detector df6 (Relay df8) and starts Timer 12eb (20 s).
  // Killing a fleeing inmate is a kill by the player (p169 QuestStart 350: Reputation Points Sender
  // 11e1 -10, and Relays 11e3 / 11e4 destroyed); sparing both gives +10 each when the vision comes
  // (Relay df9 -> 11e3 / 11e4 -> Sender 11e2).
  { id: '0.fight', obj: 'as the creature, kill the three attackers (Count Down de6); spare the two inmates who flee', do: 'arena', stand: [457.5, 97.7, 225], hold: 14, prey: [0xddd, 0xde0, 0xde3], spare: [0xdcb, 0xdda], until: `__world.world.get(0xde6).s.count === 0`, timeout: 150, expect: { dead: [0xddd, 0xde0, 0xde3], actorAlive: [0xdcb, 0xdda] }, shot: true },
  // Detector df6 (the pen) sends On on entering again to three Visiblity Message Filters: looking
  // east (df7), south (1007) or north (100f) chooses which of three visions (Relays 115e / 1162 /
  // 1160: Animating Statics df4.. / 1000.. / 1008.. behind Visibility Togglers) Screen Fader e00
  // shows (Time Scale e01, Screen Blur 1157, Camera Shake e02, Adrenaline Sender 1159); Timer 12eb
  // shows the east one after 20 s. Relay df9 also changes him back (Toggle 1141 Off) and pays the
  // spared inmates' reputation.
  { id: '0.vision', obj: 'in the pen (Detector df6), look east (filter df7): the vision', do: 'vision', stand: [457, 97.7, 225], tol: 1.5, at: [461.3, 99.3, 225.9], ready: `!!__world.world.get(0xdf6)?.enabled`, readyTimeout: 40, until: `__pt.msgs(600).split('; ').some((m) => m.split(' ')[3] === 'df9')`, timeout: 60, shot: true },
  { id: '0.vision-end', obj: 'the vision plays out (its sounds end: Timer e05 -> Timer 115b)', do: 'wait', strip: 0.6, until: `__pt.msgs(600).split('; ').some((m) => m.split(' ')[3] === '115b')`, timeout: 20, shot: true },
  // The vision's sounds end (Timer e05: the statics destroyed, Screen Fader e08), Relay 127c starts
  // the guards' last lines (Behavior Changers 114f / 1151 / 1153 / 1155) and Timer 12f0 (17 s):
  // Screen Fader 1171, then Timer 12ef (3 s) or the end of 1155's talk fires Level Transition 1172
  // ("West Spawn", chapter 5:585).
  { id: '0.exit', obj: 'human again; the guards talk, the screen fades: Level Transition 1172 to 1a', do: 'wait', strip: 4, until: `/1a PrisonDeathRow/i.test(__world.world.opts.levelPath ?? '') && __world.world.time > 0.5`, timeout: 120, noCineWait: true, expect: { level: '1a PrisonDeathRow' }, shot: true },
  // The hand-off: 1a's Player Spawn Point 894e "West Spawn" (from the Prelude; its p6 is 1a's own
  // map 4:668) is where New Game starts 1a (its Player object, 0.3 m away), so 1a opens as on a
  // New Game: Timer 7ca4 starts "Goose" 7509, watched and skipped as in 1a.intro; the cell door
  // gives way ("BustedDoor" 5b9e).
  { id: '0.1a', obj: '1a from the Prelude, at West Spawn 894e: watch the opening, skip it (Enter); the cell door gives way', do: 'intro', watch: WATCH, then: { until: `!!__world.world.get(0x5b9e).s.played && Math.hypot(__player.position.x - 398.8, __player.position.z - 516.7) < 2`, timeout: 20, wait: 2 }, expect: { level: '1a PrisonDeathRow', played: [0x7509, 0x5b9e] }, shot: true },
  // ---- end of 0 Prelude Docks ----
];

// ---------------------------------------------------------------------------------------------

const bin = BROWSERS.find((b) => existsSync(b));
if (!bin) throw new Error('No Chromium-family browser found; set SMOKE_BROWSER');
mkdirSync(TMP, { recursive: true });
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
let server;
let cfgDir;
let base = opt('--url');
const profile = mkdtempSync(join(TMP, 'playthrough-profile-'));
let browser;
let ctl;
// The browser's crash reporter (chrome_crashpad_handler) outlives it: remember the ones that
// were already running and kill the ones this run started.
const crashpads = () => (spawnSync('pgrep', ['-f', '(Brave|Chrome|Chromium|Edge).*chrome_crashpad_handler'], { encoding: 'utf8' }).stdout ?? '').split('\n').filter(Boolean).map(Number);
const crashpadsBefore = new Set(crashpads());
const cleanup = () => {
  try {
    ctl?.close();
  } catch {}
  try {
    browser?.kill('SIGKILL');
  } catch {}
  for (const pid of crashpads()) {
    if (crashpadsBefore.has(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  try {
    if (server) process.kill(-server.pid, 'SIGTERM');
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {}
  try {
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const report = { started: new Date().toISOString(), ...(IGNORE_PLAYER ? { ignorePlayer: true } : {}), steps: [], bugs: [], saves: [], perf: {}, logs: [] };
let failures = 0;
let stepHook = null;
// GET /abort on the control server (--keep): the running step's loops give up (exploring by hand).
let abortRun = false;

try {
  if (!base) {
    const port = await freePort();
    // Own dev server without file watching / HMR: edits in the tree must not reload the page.
    cfgDir = mkdtempSync(join(TMP, 'playthrough-vite-'));
    const cfg = join(cfgDir, 'vite.config.mjs');
    writeFileSync(
      cfg,
      `import base from ${JSON.stringify(join(ROOT, 'vite.config.ts'))};\nexport default { ...base, root: ${JSON.stringify(ROOT)}, cacheDir: ${JSON.stringify(join(cfgDir, 'cache'))}, server: { ...(base.server ?? {}), hmr: false, watch: null } };\n`,
    );
    server = spawn('npx', ['vite', '--config', cfg, '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
    base = `http://localhost:${port}`;
  }
  // (Generous: a machine shared with other runs can take minutes to start Vite and the browser.)
  await waitFor(async () => (await fetch(base)).ok, 180_000, 'dev server');
  const dbg = await freePort();
  browser = spawn(
    bin,
    [
      '--headless=new',
      '--disable-component-update',
      '--disable-background-networking',
      '--disk-cache-size=1',
      '--media-cache-size=1',
      '--disable-gpu-shader-disk-cache',
      `--remote-debugging-port=${dbg}`,
      `--user-data-dir=${profile}`,
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      // --window 1728,1117[,2]: the window size (and device scale factor) of the reference display.
      ...(opt('--window') ? [`--window-size=${opt('--window').split(',').slice(0, 2).join(',')}`, `--force-device-scale-factor=${opt('--window').split(',')[2] ?? 1}`] : ['--window-size=1280,720']),
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.type === 'page'), 90_000, 'browser');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  // (The page's console, printed when the run dies before its report: a boot that never loads.)
  globalThis.__ptLogs = logs;
  const problems = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Runtime.exceptionThrown') {
      const t = d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text;
      logs.push(`EXC ${t}`);
      problems.push(`exception: ${t.slice(0, 400)}`);
    } else if (d.method === 'Runtime.consoleAPICalled') {
      const t = d.params.args.map((a) => a.value ?? a.description).join(' ');
      logs.push(`${d.params.type} ${t}`);
      if (d.params.type === 'error') problems.push(`console.error: ${t.slice(0, 400)}`);
      if (d.params.type === 'warning' || d.params.type === 'warn') problems.push(`warn: ${t.slice(0, 300)}`);
    } else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon/i.test(d.params.entry.url ?? '')) {
      logs.push(`LOG ${d.params.entry.text} ${d.params.entry.url ?? ''}`);
      problems.push(`log: ${d.params.entry.text} ${d.params.entry.url ?? ''}`.slice(0, 400));
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const VK = { Enter: 13, Escape: 27, KeyW: 87, KeyE: 69, Space: 32, ArrowDown: 40, ArrowUp: 38 };
  const keyEv = (type, code) => send('Input.dispatchKeyEvent', { type, code, key: code === 'KeyW' ? 'w' : code === 'KeyE' ? 'e' : code === 'Space' ? ' ' : code, windowsVirtualKeyCode: VK[code] ?? 0 });
  const press = async (code, ms = 110) => {
    await keyEv('keyDown', code);
    await sleep(ms);
    await keyEv('keyUp', code);
  };
  let wHeld = false;
  const hold = async (on) => {
    if (on === wHeld) return;
    wHeld = on;
    await keyEv(on ? 'keyDown' : 'keyUp', 'KeyW');
  };
  // Back-pedal / strafe keys held in a fight (the Inferna kite below): the set held now.
  const sideHeld = new Set();
  const sideKeys = async (want) => {
    for (const k of ['KeyS', 'KeyA', 'KeyD']) {
      const on = want.includes(k);
      if (on === sideHeld.has(k)) continue;
      if (on) sideHeld.add(k);
      else sideHeld.delete(k);
      await keyEv(on ? 'keyDown' : 'keyUp', k);
    }
  };
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  // png: a lossless frame at the full device resolution (GET /shot?name=&png=1, for tools/image-metrics.ts).
  const shot = async (name, png = false) => {
    if (!shotsDir) return null;
    const vp = (await send('Page.getLayoutMetrics')).result?.cssVisualViewport ?? { clientWidth: 1280, clientHeight: 720 };
    const r = await send('Page.captureScreenshot', png ? { format: 'png' } : { format: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: vp.clientWidth, height: vp.clientHeight, scale: 0.5 } });
    if (!r.result?.data) return null;
    const p = join(shotsDir, `${name.replace(/[^\w.-]+/g, '_')}.${png ? 'png' : 'jpg'}`);
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    return p;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  const PAGE = readFileSync(join(ROOT, 'tools/playthrough-page.js'), 'utf8');
  /** Invulnerability (logged shortcut): kept across checkpoint restores / loads / transitions. */
  let godMode = has('--invulnerable');
  /** (Re-)inject the page helpers when the level (world) changed: start, restore, load, transition. */
  /** The front end's end-of-game screens (Game Finished, the credits): the level is gone. */
  const inEndScreens = () => ev(`!!window.__menu && !__menu.inGame && __menu.frontend.stack.some((t) => ['gameFinished', 'credits'].includes(t.screen.id))`).catch(() => false);
  const ensurePage = async () => {
    const ok = await ev(`!!(window.__world?.world && window.__actors?.combat && window.__view?.collision)`).catch(() => false);
    if (!ok && (await inEndScreens())) return false;
    if (!ok) await waitFor(() => ev(`!!(window.__world?.world && window.__actors?.combat && window.__view?.collision && window.__world.world.time > 0.5)`), 120_000, 'level systems');
    if (godMode) await ev(`(() => { __actors.combat.invulnerable = true; return 1; })()`);
    if (DEATHS.size) await ev(RESTORE_PAGE);
    if (await ev(`window.__pt?.world === __world.world && !!__actors.combat.__ptWrapped`)) return false;
    await ev(PAGE);
    return true;
  };
  const RESTORE_PAGE = readFileSync(join(ROOT, 'tools/playthrough-restore.js'), 'utf8');
  const levelNow = () => ev(`window.__world?.world?.opts.levelPath ?? ''`);
  const stem = (p) => ((p ?? '').split(/[\\/]/).pop() ?? '').replace(/\.lvl$/i, '');

  // ------------------------------------------------------------------------------------------
  // Step context and actions

  let cur = null; // the running step's record
  const note = (s) => {
    cur?.notes.push(s);
    console.log(`     ${s}`);
  };
  const shortcut = (kind, why) => {
    cur?.shortcuts.push(`${kind}: ${why}`);
    console.log(`     SHORTCUT ${kind}: ${why}`);
  };
  /** Checkpoints taken so far (the save system's console line). */
  const checkpointsTaken = () => logs.filter((l) => /\[save\] checkpoint \(/.test(l)).length;
  const alive = () => ev(`(window.__actors?.combat?.health ?? 1) > 0`).catch(() => true);
  // (A creature holding the player is not a cinematic: the run struggles instead.)
  // A Movie Player's video (3b's flashbacks 17:1 / 17:2) counts too: its layer takes keys while
  // it shows (a Space pressed then skips it instead of reaching the game).
  // (Not on the Game Finished / credits screens: the left level's player reads as disabled, and
  // every step end waited 240 s there.)
  const cinematic = () => ev(`!!window.__world && !(!!window.__menu && !__menu.inGame && __menu.frontend.stack.some((t) => ['gameFinished', 'credits'].includes(t.screen.id))) && (__world.world.activeCutscenes().length > 0 || (!__player.enabled && !__player.attackOverride) || [...document.querySelectorAll('.cutscene-layer')].some((e) => e.style.display !== 'none'))`).catch(() => false);

  /** Died: wait for the checkpoint restore (4 s), re-inject, and report. */
  class Died extends Error {}
  const checkDeath = async () => {
    if (await alive()) return;
    await hold(false);
    await sideKeys([]);
    note(`player died (${JSON.stringify(await ev(`(window.__pt?.dmg ?? []).slice(-3)`).catch(() => []))}); the last 40 s: ${await ev(`(() => { const d = window.__pt?.dmg ?? []; const t1 = d.at(-1)?.t ?? 0; const by = {}; for (const x of d) if (x.t > t1 - 40) by[x.from || x.at.split(' ')[1]] = +((by[x.from || x.at.split(' ')[1]] ?? 0) + x.amount).toFixed(1); return JSON.stringify(by); })()`).catch(() => '?')}`);
    await waitFor(async () => (await ev(`(window.__actors?.combat?.health ?? 0) > 0`).catch(() => false)), 30_000, 'checkpoint restore after death');
    await sleep(1500);
    await ensurePage();
    throw new Died('player died');
  };

  /**
   * Wait for a page condition, watching for the player's death (the gas chamber kills while the
   * route waits: without this the game's own checkpoint restore passed for "not played").
   */
  const waitAlive = async (js, secs, what) => {
    const end = Date.now() + secs * 1000;
    let last;
    while (Date.now() < end && !abortRun) {
      await checkDeath();
      try {
        if (await ev(js)) return true;
      } catch (e) {
        last = e;
      }
      await sleep(200);
    }
    cur.problems.push(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
    return false;
  };

  let cineCount = 0;
  const cineN = async () => cineCount;
  const waitCine = async (timeout = 240) => {
    cineCount++;
    const end = Date.now() + timeout * 1000;
    let seen = false;
    // --cine-strip <s>: with --shots, a frame of the cinematic every <s> seconds (8 at most).
    const every = Number(opt('--cine-strip', '0')) * 1000;
    let frames = 0;
    let nextShot = 0;
    while (Date.now() < end) {
      const c = await cinematic();
      if (!c) break;
      if (!seen) {
        seen = true;
        if (cur) cur.cineSeen = true;
        const names = await ev(`__world.world.activeCutscenes().map((c) => c.name + ' ' + c.duration.toFixed(1) + 's')`).catch(() => []);
        note(`cinematic ${names.join(', ') || '(player control off)'}`);
        nextShot = Date.now() + 300;
      }
      if (every && shotsDir && frames < 8 && Date.now() >= nextShot) {
        nextShot = Date.now() + every;
        await shot(`${cur?.id ?? 'x'}-cine-${(await cineN()) || 0}-f${++frames}`);
      }
      await sleep(400);
    }
    await ensurePage();
    return seen;
  };

  /**
   * A step's `sea` [y, [x, y, z]]: below y the player is in the sea off 10's dock, which holds him
   * but has no way back up (docs/playthrough.md "10 Docks"): fights do not close on a creature
   * down there (walking off the edge after it), and a player knocked in is put back on the dock
   * at the point given (logged).
   */
  let fightFloor = null;
  const outOfSea = async (step) => {
    if (!step.sea || !(await ev(`__player.position.y < ${step.sea[0]}`).catch(() => false))) return false;
    const to = step.sea[1];
    await hold(false);
    shortcut('teleport', `knocked into the sea by the dock (y < ${step.sea[0]}): no way back up, put back at ${to.join(', ')}`);
    await ev(`(() => { __pt.ap.active = false; __pt.ap.follow = 0; __player.teleport({ x: ${to[0]}, y: ${to[1]}, z: ${to[2]} }); return 1; })()`);
    await sleep(500);
    return true;
  };

  /**
   * An arena's walk back to its stand. With `sea` (10's dock): a player left where no path leads
   * back (thrown off the dock's far side, carried up onto the road by a Mainliner) is put back on
   * the stand (logged), as for the sea.
   */
  const backToStand = async (step, area) => {
    const r = await walk(step.stand, 1.0, 20, { area, drop: step.drop });
    if (r.arrived || !step.sea || r.plan?.ok) return r;
    const at = (await ev(`__pt.state()`)).p.map((v) => v.toFixed(1));
    shortcut('teleport', `stranded at ${at.join(', ')} with no path back to the dock (${r.d} m short): put back at ${step.sea[1].join(', ')}`);
    await ev(`(() => { __pt.ap.active = false; __pt.ap.follow = 0; __player.teleport({ x: ${step.sea[1][0]}, y: ${step.sea[1][1]}, z: ${step.sea[1][2]} }); return 1; })()`);
    await sleep(500);
    return r;
  };

  /** A short straight move (no planner, no fights on the way): into cover. */
  const stepTo = async (to, secs = 3) => {
    await ev(`(() => { const p = __player.position; __pt.ap.follow = 0; __pt.go([[p.x, p.y, p.z], ${JSON.stringify(to)}], 0.35); return 1; })()`);
    await hold(true);
    const end = Date.now() + secs * 1000;
    while (Date.now() < end && !(await ev(`__pt.ap.done`).catch(() => true))) await sleep(80);
    await hold(false);
    await ev(`(() => { __pt.ap.active = false; return 1; })()`);
  };

  // `stay`: a page expression; while it holds the player keeps his ground (turns and swings at
  // what comes into reach, does not walk: the 1a gas chamber's lit floor tiles).
  // `area` [x, z, r]: only creatures within r m of (x, z) are engaged (engage()).
  const fight = async (seconds = 40, all = false, huntOnly = false, stay = null, area = null) => {
    const end = Date.now() + seconds * 1000;
    let quiet = 0;
    let hits = 0;
    let kills = 0;
    let closing = 0;
    let futile = 0;
    let target = null;
    let kiteDir = 1;
    let kiteFlip = 0;
    let coverUntil = 0;
    let coverNext = 0;
    let covers = 0;
    while (Date.now() < end && !abortRun) {
      await checkDeath();
      if (await cinematic()) {
        await hold(false);
        await sideKeys([]);
        await waitCine();
        continue;
      }
      // Low on health with a Xombium bottle in hand: drink (the H key needs pointer lock).
      if (await ev(`__actors.combat.health < 40 && (__hud.model().healthPacks ?? 0) > 0 && __weapons.service.useHealthPack()`)) shortcut('api', 'Xombium bottle through useHealthPack (the H key needs pointer lock)');
      const t = await ev(`(() => { const t = __pt.engage(${all ? '40, true' : huntOnly ? '14, false, true' : '14'}${area ? `${all || huntOnly ? '' : ', false, false'}${all ? ', false' : ''}, ${JSON.stringify(area)}` : ''}); if (!t) return null; const shoot = __pt.canShoot(t.id); const swing = (t.d <= 1.7 || shoot) && __pt.attack(t.id); /* An Inferna is shot from where the player stands: walking up to it is walking into its burning footprints (9 Lighthouse). */ const ta = __actors.manager.actors.find((x) => x.id === t.id); const keep = shoot && (t.d < 15 || ta?.entity?.className === 'Inferna' || Math.abs((ta?.motor.position.y ?? 0) - __player.position.y) > 2); const p = __player.position; const near = (shoot || __pt.inFire()) && (__pt.inFire() || __actors.manager.actors.some((a) => a.alive && __pt.infMode(a) === 'flaming' && Math.hypot(a.position.x - p.x, a.position.z - p.z) < 7 && Math.abs(a.position.y - p.y) < 3) || (t.st === 'attack' && t.d < 3 && !ta?.profile?.ranged && ta?.entity?.className !== 'Burrower')); const room = near ? __pt.evadeKeys(${area ? JSON.stringify(area) : 'null'}) : null; const kite = !!room && !Array.isArray(room) ? room : null; return { ...t, act: t.d > 1.0 && !keep ? 'close' : 'hit', swing, kite }; })()`);
      // Gunmen (Slayers, guards with guns) need a clear line at their Fire marker: with one shooting
      // at him and the player under 70, he takes cover within 8 m out of all their lines and
      // holds it, shooting what comes round (they come closer to find a line: shotgun range),
      // for 8 s or until one has a line again (looked at every 2 s).
      const nowT = Date.now();
      if (!stay && nowT >= coverNext && (nowT >= coverUntil || (nowT - (coverUntil - 8000)) > 2000)) {
        coverNext = nowT + 2000;
        // (Not in the creature form: it fights hand to hand, and its meter drains while it waits.)
        const ex = await ev(`({ n: __pt.exposed().length, hp: __actors.combat.health, human: (window.__insanity?.model?.form ?? 'human') === 'human' })`);
        // (Only once hurt: with the player at full strength covering stalled 2's riot for its 300 s,
        // its inmates shooting on while he hid, run d2.)
        if (ex.human && ex.hp < 70 && ex.n >= 1) {
          const spot = await ev(`__pt.coverSpot(8, ${area ? JSON.stringify(area) : 'null'})`);
          if (spot) {
            await hold(false);
            await sideKeys([]);
            await stepTo(spot, 3);
            coverUntil = Date.now() + 8000;
            covers++;
            target = null;
            quiet = 0;
            continue;
          }
          coverNext = nowT + 4000;
        }
      }
      if (!t) {
        await hold(false);
        await sideKeys([]);
        if (++quiet > 12) break;
        await sleep(100);
        continue;
      }
      quiet = 0;
      // A burning Inferna within 7 m: back off and sidestep while shooting. It circles its target
      // at 4 m and within 0..5 m bursts into flame (Radius Damage 20 -> 5 over 8 m); from 6 m on it
      // throws fireballs at where the player stood, which a sidestep leaves behind (§15.7.6).
      // (Also a creature swinging at the player within 3 m while he shoots: its blades sweep
      // through his hit spheres, and a step back takes him out of the sweep. Not a Burrower: it is
      // up, and hurtable, only while it strikes, so the player stands and shoots. Only where the floor
      // behind is there: not off a roof or the dock, __pt.evadeKeys.)
      if (Date.now() < coverUntil && !t.kite) {
        await hold(false);
        await sideKeys([]);
        if (t.swing) hits++;
        target = t;
        await sleep(100);
        continue;
      }
      if (t.kite && !stay) {
        await hold(false);
        if (t.kite.pref) kiteDir = t.kite.pref === 'right' ? 1 : -1;
        else if (Date.now() > kiteFlip) (kiteDir = -kiteDir), (kiteFlip = Date.now() + 1200 + Math.random() * 1200);
        if (kiteDir > 0 && !t.kite.right && t.kite.left) kiteDir = -1;
        else if (kiteDir < 0 && !t.kite.left && t.kite.right) kiteDir = 1;
        const side = kiteDir > 0 ? (t.kite.right ? 'KeyD' : null) : t.kite.left ? 'KeyA' : null;
        await sideKeys(['KeyS', ...(side ? [side] : [])]);
        if (t.swing) hits++;
        target = t;
        await sleep(100);
        continue;
      }
      if (sideHeld.size) await sideKeys([]);
      // Kept to an area: a chase that has taken the player 3 m past its edge ends (the arena walks
      // back to its stand; 4a's pit fight followed creatures into the cloners' corner, bug 4-5).
      if (area && (await ev(`(() => { const p = __player.position; return Math.hypot(p.x - ${area[0]}, p.z - ${area[1]}) > ${area[2] + 3}; })()`))) break;
      if (target && target.id !== t.id) (kills++, (closing = 0), (futile = 0));
      if (stay && (await ev(stay).catch(() => false))) {
        await hold(false);
        if (t.swing) hits++;
        target = t;
        await sleep(100);
        continue;
      }
      // Swinging without effect (something between: a slanted grate, a shelf): go round to the
      // creature's far side on a planned path.
      if (t.swing && target && target.id === t.id && t.hp >= target.hp) futile++;
      else if (t.hp < (target?.hp ?? Infinity)) futile = 0;
      if (futile >= 12) {
        futile = 0;
        await hold(false);
        await ev(`(() => { __pt.ap.follow = 0; return 1; })()`);
        const side = await ev(`(() => { const a = __actors.manager.actors.find((x) => x.id === ${t.id}); const q = a?.motor.position, p = __player.position; if (!q) return null; const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1; return [q.x + (dx / l) * 1.1, q.y, q.z + (dz / l) * 1.1]; })()`);
        if (side) {
          note(`#${hex(t.uid)} takes no hits from here: going round`);
          await walkRaw(side, 0.6, 10);
        }
        target = t;
        continue;
      }
      // Walking straight at it gets nowhere (a shelf, a ledge): go round on a planned path.
      if (target && target.id === t.id && t.act === 'close' && Math.abs(t.d - target.d) < 0.05) closing++;
      else closing = 0;
      target = t;
      if (closing > 25) {
        closing = 0;
        await hold(false);
        await ev(`(() => { __pt.ap.follow = 0; return 1; })()`);
        const pos = await ev(`(() => { const a = __actors.manager.actors.find((x) => x.id === ${t.id}); const q = a?.motor.position; return q ? [q.x, q.y, q.z] : null; })()`);
        if (pos) await walkRaw(pos, 1.2, 6);
        continue;
      }
      // (Not after a creature in the sea: the player would follow it off the dock.)
      // (Nor over an edge: __pt.edgeAhead.)
      if (t.act === 'close' && !(fightFloor !== null && (await ev(`(__actors.manager.actors.find((x) => x.id === ${t.id})?.motor.position.y ?? 1e9) < ${fightFloor}`))) && !(await ev(`__pt.edgeAhead()`).catch(() => false))) await hold(true);
      else await hold(false);
      if (t.swing) hits++;
      await sleep(100);
    }
    await hold(false);
    await sideKeys([]);
    await ev(`(() => { __pt.ap.follow = 0; return 1; })()`);
    if (hits) note(`fought: ${hits} swings, hp ${await ev('__actors.combat.health')}${covers ? `, took cover ${covers} time(s)` : ''}`);
    return hits;
  };

  /** Transformed: press Insanity again (the key's own call: Q needs pointer lock). */
  const changeBack = async (why) => {
    if (!(await ev(`window.__insanity?.model?.form === 'creature'`).catch(() => false))) return;
    // A scripted transformation the key cannot undo (Allow Player Insanity Object flag 0x80:
    // the Prelude's creature form until its Toggle object changes him back).
    if (await ev(`!!__insanity.model.s.noTransform`).catch(() => false)) return;
    shortcut('api', 'insanity change-back through the model\'s Insanity key handler (the Q key needs pointer lock)');
    note(`changed back (${why})`);
    await ev(`(() => { __insanity.model.pressInsanity(); return 1; })()`);
    await waitFor(() => ev(`__insanity.model.form === 'human'`), 8000, 'change back').catch(() => {});
  };

  /** Walk to a point: plan, hold W, open doors in the way, fight what attacks, wait out cinematics. */
  const walkRaw = (to, tol, maxSec) => walk(to, tol, maxSec, { noFight: true });
  // `area` [x, z, r]: fights on the way keep to it (an arena's walk back to its stand).
  const walk = async (to, tol = 0.6, maxSec = 90, { noFight = false, drop = undefined, area = null } = {}) => {
    const planJs = `(() => { const p = __player.position; const r = __pt.plan([p.x, p.y, p.z], ${JSON.stringify(to)}, { tol: ${tol}${drop ? `, drop: ${drop}` : ''} }); __pt.go(r.pts, 0.35); return { ok: r.ok, rem: r.remaining, n: r.pts.length, ms: r.ms, timedOut: r.timedOut }; })()`;
    let plan = await ev(planJs);
    // Moving obstacles (a door still falling, a prop settling): plan again for a few seconds,
    // while the search comes out differently (the same shortfall again: nothing is moving).
    for (let n = 0; n < 6 && !plan.ok; n++) {
      await sleep(600);
      const prev = plan;
      plan = await ev(planJs);
      if (!plan.ok && Math.abs(plan.rem - prev.rem) < 0.1) break;
    }
    if (!plan.ok) note(`no full path to ${to.map((v) => v.toFixed(1))} (${plan.rem} m short${plan.timedOut ? `, search stopped after ${(plan.ms / 1000).toFixed(1)} s` : ''})`);
    // Time spent in cinematics and fights does not count against maxSec.
    let end = Date.now() + maxSec * 1000;
    const hardEnd = end + 240_000;
    let opened = 0;
    let jumps = 0;
    let replans = 0;
    let doorTries = new Map();
    // A walk into a Level Transition's Detector (8a's exit 1b70) ends in another level: the page's
    // systems are torn down under the loop (`__actors` undefined); the walk is over, not failed.
    const startLevel = await levelNow();
    const leftLevel = async () => (await levelNow().catch(() => '')) !== startLevel || !!(await ev(`!!window.__campaign?.service?.pending`).catch(() => false));
    await hold(true);
    while (Date.now() < end && !abortRun) {
      await sleep(80);
      await checkDeath();
      if (await cinematic()) {
        const t0 = Date.now();
        await hold(false);
        await waitCine();
        end += Date.now() - t0;
        if (await leftLevel()) break;
        plan = await ev(planJs);
        await hold(true);
        continue;
      }
      let s;
      try {
        s = await ev(`(() => { const ap = __pt.ap; const near = __pt.engage(7); if (near && (${noFight} || !['chase', 'attack', 'shoot', 'hurt'].includes(near.st))) { ap.follow = 0; ap.active = !ap.done; } return { done: ap.done, stuck: ap.stuck, door: (ap.stuck >= 1 || ap.active) ? __pt.blockingDoor() : null, threat: near && ['chase', 'attack', 'shoot', 'hurt'].includes(near.st) ? near : null }; })()`);
      } catch (e) {
        if (await leftLevel()) break;
        throw e;
      }
      if (s.done) break;
      // (A walk that does not fight walks on: engage() stops the autopilot and turns the view to
      // the creature, and such a walk then stood still under its blows to its end, run b2.)
      if (s.threat && !noFight) {
        await hold(false);
        note(`attacked by #${hex(s.threat.uid)} (${s.threat.st}, ${s.threat.d} m)`);
        const t0 = Date.now();
        await fight(40, false, false, null, area);
        // Fights extend the walk's time, up to 4 minutes in all.
        const ext = Math.min(Date.now() - t0, Math.max(0, hardEnd - end));
        end += ext;
        plan = await ev(planJs);
        await hold(true);
        continue;
      }
      if (s.door) {
        const n = (doorTries.get(s.door) ?? 0) + 1;
        doorTries.set(s.door, n);
        if (n <= 3) {
          await hold(false);
          await ev(`(() => { __pt.ap.active = false; return 1; })()`);
          await useObj(parseInt(s.door, 16), { walkFirst: false });
          await sleep(1200);
          opened++;
          plan = await ev(planJs);
          await hold(true);
          continue;
        }
      }
      if (s.stuck >= 2) {
        if (jumps < 2) {
          jumps++;
          await press('Space');
          await ev(`(() => { __pt.ap.stuck = 0; return 1; })()`);
          continue;
        }
        if (replans < 2) {
          replans++;
          plan = await ev(planJs);
          continue;
        }
        note('stuck');
        break;
      }
    }
    await hold(false);
    if (await leftLevel()) {
      note(`left ${stem(startLevel)} on the way (a level transition)`);
      return { arrived: true, d: 0, plan, leftLevel: true };
    }
    // (A walk that ends in a drop, 6a's creek bank, is measured once the player has landed.)
    await ev(`(() => { __pt.ap.active = false; return 1; })()`).catch(() => {});
    await waitFor(() => ev(`__player.onGround`), 2500, 'landing').catch(() => {});
    // (The level can be left during that wait: a walk that ends in a transition's Detector.)
    if (await leftLevel()) {
      note(`left ${stem(startLevel)} on the way (a level transition)`);
      return { arrived: true, d: 0, plan, leftLevel: true };
    }
    const st = await ev(`__pt.state()`);
    const d = Math.hypot(st.p[0] - to[0], st.p[2] - to[2]);
    if (opened) note(`opened ${opened} door(s) on the way`);
    return { arrived: d <= Math.max(tol, 0.6) + 0.3 && Math.abs(st.p[1] - to[1]) < 1.6, d: +d.toFixed(2), plan };
  };

  /** Walk to a spot the object can be used from (tries a few), look at it, press E. */
  async function useObj(uid, { walkFirst = true, wantOpen = false, look = null } = {}) {
    // A door by its handle (the fit anchor), else by the middle of its meshes (something in front
    // of the handle, a crate, can take the view's pick).
    const aim = async () => {
      let t = 0;
      // `look` [x, y, z]: a point that picks it from the step's stand (8b's stove door 1e37: its
      // open leaf turns the anchor and the middle away; its hinge does it).
      if (look) {
        await ev(`(() => { __pt.ap.follow = 0; __pt.ap.active = false; __pt.aimAt(${look[0]}, ${look[1]}, ${look[2]}); return 1; })()`);
        await sleep(350);
        if ((t = await ev(`__world.pickTarget()?.w?.uid ?? 0`)) === uid) return t;
      }
      for (const [at, up] of [['useAim', 0], ['center', 0], ['center', 0.6]]) {
        // (Nothing else may turn the view meanwhile: a creature engaged on the way (ap.follow)
        // or the autopilot keep turning it on every frame, and the look at the door was lost.)
        await ev(`(() => { __pt.ap.follow = 0; __pt.ap.active = false; const c = __pt.${at}(${uid}); __pt.aimAt(c[0], c[1] + ${up}, c[2]); return 1; })()`);
        await sleep(350);
        if ((t = await ev(`__world.pickTarget()?.w?.uid ?? 0`)) === uid) break;
      }
      return t;
    };
    let t = await aim();
    if (t !== uid && walkFirst) {
      for (const sp of await ev(`__pt.standFor(${uid}, 1.1, true)`)) {
        await walk(sp, 0.3, 40);
        if ((t = await aim()) === uid) break;
      }
    }
    if (t !== uid) note(`use #${hex(uid)}: the view targets ${t ? '#' + hex(t) : 'nothing'}`);
    // Not E on a crate in front of the door: it would grab it (1a lower corridor: 80ed by 4ed6).
    if (t && t !== uid && (await ev(`__world.world.get(${t})?.cls ?? ''`)) === 'Pushable') return false;
    // A door the step wants open that the walk to it has already opened (its door helper): E
    // would shut it again (5b's cell door 1115).
    if (wantOpen && (await ev(`!!__world.world.get(${uid})?.s?.open`))) {
      note(`#${hex(uid)} already open`);
      return true;
    }
    await press('KeyE');
    await sleep(300);
    return t === uid;
  }

  // `aim`: the object the player looks at to take it (1a: the Shiv in the corpse's back, which
  // Use routes through the Quest Item Pickup `uid`); `uid` by default.
  const pick = async (uid, aim = uid) => {
    const pos = await ev(`__world.world.get(${aim}).pos`);
    await walk(pos, 1.0, 40);
    if (await ev(`!!__world.world.get(${uid}).s.taken`)) return true;
    // Look at it until the view's own pick test offers it (a busy frame can lag the view), then E.
    for (let n = 0; n < 3; n++) {
      await ev(`(() => { __pt.ap.follow = 0; __pt.ap.active = false; const w = __world.world.get(${aim}); __pt.aimAt(w.pos[0], w.pos[1] + 0.1, w.pos[2]); return 1; })()`);
      await sleep(350);
      const t = await ev(`__world.pickTarget()?.w?.uid ?? 0`);
      if (t !== uid) note(`pick #${hex(uid)}: the view targets ${t ? '#' + hex(t) : 'nothing'}`);
      await press('KeyE');
      await sleep(400);
      if (await ev(`!!__world.world.get(${uid}).s.taken`)) return true;
      if (n === 1) await walk(await ev(`__world.world.get(${aim}).pos`), 0.7, 10);
    }
    return false;
  };

  // Pick up what lies by the route, as a player does (step `loot: <m>`): the lockers within reach
  // are opened (Use; their pickups are enabled by the opening), then each item within `radius` m
  // (shown, enabled, not taken, about the player's floor, a planned path to it) is walked to and
  // taken with E (most are taken on touch). An item the player cannot carry more of is left.
  const lootTried = new Set();
  const loot = async (radius = 8) => {
    const PICK = `new Set(['Ammo Box', 'Health Bonus Item', 'Item', 'Map Pack', 'Flashlight', 'Family Picture'])`;
    const lockers = await ev(`(() => { const p = __player.position, w = __world.world, P = ${PICK}, out = []; for (const s of w.of('Switch')) { if (s.destroyed || !s.visible || s.s.open || !s.s.unlocked || !w.switchUsable(s) || ${JSON.stringify([...lootTried])}.includes(s.uid)) continue; if (!s.e.links.some((u) => { const t = w.get(u); return t && P.has(t.cls) && !t.s.taken && !t.destroyed; })) continue; const d = Math.hypot(s.pos[0] - p.x, s.pos[2] - p.z); if (d < ${radius} && Math.abs(s.pos[1] - p.y) < 2) out.push([s.uid, d]); } return out.sort((a, b) => a[1] - b[1]).map((x) => x[0]); })()`);
    let opened = 0;
    let taken = 0;
    for (const u of lockers) {
      lootTried.add(u);
      if (!(await ev(`__pt.plan([__player.position.x, __player.position.y, __player.position.z], __world.world.get(${u}).pos, { tol: 1.4, budget: 2500, shiftBudget: 500 }).ok`))) continue;
      await useObj(u);
      await sleep(900);
      if (await ev(`!!__world.world.get(${u}).s.open`)) opened++;
    }
    for (let n = 0; n < 16; n++) {
      const it = await ev(`(() => { const p = __player.position, w = __world.world, P = ${PICK}, skip = new Set(${JSON.stringify([...lootTried])}); let best = 0, bd = ${radius}; for (const [c, l] of w.byClass) { if (!P.has(c)) continue; for (const e of l) { if (e.destroyed || e.s.taken || !e.visible || !e.enabled || skip.has(e.uid) || Math.abs(e.pos[1] - p.y) > 1.6) continue; const d = Math.hypot(e.pos[0] - p.x, e.pos[2] - p.z); if (d < bd) (bd = d), (best = e.uid); } } return best; })()`);
      if (!it) break;
      lootTried.add(it);
      if (!(await ev(`__pt.plan([__player.position.x, __player.position.y, __player.position.z], __world.world.get(${it}).pos, { tol: 0.9, budget: 2500, shiftBudget: 500 }).ok`))) continue;
      if (await pick(it)) taken++;
    }
    if (opened || taken) note(`looted: ${opened} locker(s) opened, ${taken} item(s) taken`);
  };

  // Follow an NPC (keep within ~3 m). With `fight`, creatures hunting nearby are fought first,
  // and when the NPC stands waiting (a guide holds until the way is clear) the player goes for
  // the hostiles around (arena mode) instead of idling next to it.
  const follow = async (uid, untilJs, timeout, { fight: fights = false } = {}) => {
    const end = Date.now() + timeout * 1000;
    let last = null;
    let still = 0;
    let waiting = 0;
    let lastBeh = '';
    let lastHp = Infinity;
    while (Date.now() < end && !abortRun) {
      await checkDeath();
      if (await ev(untilJs)) return true;
      if (await cinematic()) {
        await waitCine();
        continue;
      }
      // The NPC hurt away from the player (1c: the inmate flees across the yard and the creatures
      // there kill him while the player fights by the gate): go to it, fighting what attacks there.
      if (fights) {
        const h = await ev(`(() => { const a = __actors.manager.actors.find((x) => x.entity?.uid === ${uid}); if (!a || a.health <= 0) return null; const q = a.motor.position, p = __player.position; return { hp: a.health, pos: [q.x, q.y, q.z], d: Math.hypot(q.x - p.x, q.z - p.z) }; })()`);
        const hurt = !!h && lastHp !== Infinity && h.hp < lastHp;
        lastHp = h?.hp ?? lastHp;
        if (hurt && h.d > 5) {
          note(`#${hex(uid)} hurt ${h.d.toFixed(1)} m away (hp ${Math.round(h.hp)}): going to it`);
          await walk(h.pos, 2.5, 12);
          await fight(10, true);
          continue;
        }
      }
      // Only creatures that hunt: one walking a scripted path past the player is left to it.
      if (fights && (await ev(`(() => { const t = __pt.engage(14, false, true); __pt.ap.follow = 0; return !!t; })()`))) {
        await fight(15, false, true);
        continue;
      }
      // A talk waits for the listener to come close (SimpleConversation p11): stay by the NPC.
      if (fights && waiting > 40 && lastBeh !== 'talk' && (await ev(`(() => { const t = __pt.engage(30, true); __pt.ap.follow = 0; return !!t; })()`))) {
        note(`#${hex(uid)} waits: going for the creatures around`);
        await fight(25, true);
        waiting = 0;
        continue;
      }
      const s = await ev(`(() => { const a = __actors.manager.actors.find((x) => x.entity?.uid === ${uid}); if (!a || a.health <= 0) return null; const q = a.motor.position, p = __player.position; return { pos: [q.x, q.y, q.z], d: Math.hypot(q.x - p.x, q.z - p.z), st: a.state, beh: a.behavior?.kind }; })()`);
      if (!s) {
        note(`#${hex(uid)} is dead`);
        return !!(await ev(untilJs));
      }
      if (last && Math.hypot(s.pos[0] - last[0], s.pos[2] - last[2]) < 0.2 && s.st === 'move') still++;
      else still = 0;
      last = s.pos;
      lastBeh = s.beh ?? '';
      // Standing in the NPC's way (actors do not steer round the player): step behind it.
      if (still > 0 && still % 12 === 0) {
        const back = await ev(`(() => { const a = __actors.manager.actors.find((x) => x.entity?.uid === ${uid}); const q = a.motor.position, t = a.lastSeen; const dx = t.x - q.x, dz = t.z - q.z, l = Math.hypot(dx, dz) || 1; return [q.x - (dx / l) * 3, q.y, q.z - (dz / l) * 3]; })()`);
        note(`#${hex(uid)} held up: the player steps behind it`);
        await walkRaw(back, 0.6, 6);
      }
      if (still === 40) note(`#${hex(uid)} has not moved for ~10 s while walking (${s.pos.map((v) => v.toFixed(1))})`);
      waiting = s.st === 'move' || s.st === 'chase' ? 0 : waiting + 1;
      if (s.d > 3.5) await walk(s.pos, 2.5, 4);
      else await sleep(250);
    }
    return false;
  };

  // State snapshot for the save / load comparison.
  const SNAP = `(() => {
    const w = __world.world;
    const doors = {}; for (const s of w.of('Switch')) doors[s.uid.toString(16)] = [!!s.s.open, !!s.s.unlocked, !!s.destroyed];
    const items = {}; for (const [c, l] of w.byClass) if (['Ammo Box', 'Health Bonus Item', 'Quest Item Pickup', 'Map Pack', 'Family Picture', 'Map Item'].includes(c)) for (const e of l) items[e.uid.toString(16)] = !!(e.s.taken || e.destroyed);
    const seqs = {}; for (const s of w.of('STOMP Player')) seqs[s.uid.toString(16)] = !!s.s.played;
    const actors = {}; for (const a of __actors.manager.actors) { if (!a.entity) continue; const q = a.motor.position; actors[a.entity.uid.toString(16)] = [a.health > 0, Math.round(a.health), Math.round(q.x), Math.round(q.z)]; }
    const det = {}; for (const d of w.of('Detector')) det[d.uid.toString(16)] = [!!d.enabled, !!d.destroyed];
    const ins = window.__insanity?.model?.s ?? {};
    return { doors, items, seqs, actors, det, hp: __actors.combat.health, rep: ins.reputation ?? null, insanity: ins.insanity ?? ins.level ?? null,
      // The lamp's charge drains while the game runs after the load, and a spare battery (4:203)
      // is used by itself when it runs low: charge + spares, compared apart within 0.06.
      weapons: JSON.stringify({ ...(window.__weapons?.persist ?? {}), battery: undefined }), battery: (window.__weapons?.persist?.battery ?? 1) + (__world.inventory?.count?.({ pkg: 4, id: 203 }) ?? 0), inv: JSON.stringify(__hud.model().healthPacks) + ' ' + !!__hud.model().flashlight?.on,
      level: w.opts.levelPath };
  })()`;
  const diffSnap = (a, b) => {
    const out = [];
    for (const k of ['doors', 'items', 'seqs', 'actors', 'det']) {
      const bad = Object.keys(a[k]).filter((u) => JSON.stringify(a[k][u]) !== JSON.stringify(b[k][u]));
      // Actors: positions may settle a little; compare alive / health / position within 1 m.
      const real = k === 'actors' ? bad.filter((u) => !b[k][u] || a[k][u][0] !== b[k][u][0] || Math.abs(a[k][u][1] - b[k][u][1]) > 1 || Math.hypot(a[k][u][2] - b[k][u][2], a[k][u][3] - b[k][u][3]) > 1.5) : bad;
      if (real.length) out.push(`${k}: ${real.slice(0, 8).map((u) => `${u} ${JSON.stringify(a[k][u])} -> ${JSON.stringify(b[k][u])}`).join(', ')}${real.length > 8 ? ` (+${real.length - 8})` : ''}`);
    }
    for (const k of ['hp', 'rep', 'insanity', 'weapons', 'inv', 'level']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
    // Rounding both to 0.05 flagged a charge that drained across a step (0.95 -> 0.9, 1b); a spare
    // used by itself after the load read as 0.04 -> 0.99 without the spares.
    if (Math.abs(a.battery - b.battery) > 0.06) out.push(`battery: ${a.battery.toFixed(3)} -> ${b.battery.toFixed(3)}`);
    return out;
  };
  /** Pause menu: move the focus to the item matching `pred` (JS over the item) and press Enter. */
  const menuChoose = async (pred) => {
    const idx = await ev(`(() => { const t = __menu.frontend.stack.at(-1); return t ? t.screen.items.findIndex((it) => ${pred}) : -1; })()`);
    if (idx < 0) throw new Error(`no menu item ${pred}`);
    for (let n = 0; n < 20 && (await ev(`__menu.frontend.stack.at(-1).sel`)) !== idx; n++) await press('ArrowDown');
    await press('Enter');
  };
  const saveLoad = async (label) => {
    const row = { label, ok: false };
    report.saves.push(row);
    if (!(await ev(`!!window.__menu`))) {
      row.error = 'skipped: no menus (started through the deep link)';
      note(row.error);
      return { ...row, ok: true };
    }
    await waitFor(async () => !(await cinematic()), 60_000, 'no cinematic');
    // Pause menu -> Save Game -> new slot.
    await press('Escape');
    await waitFor(() => ev(`__menu.isPaused && __menu.frontend.screenId === __menu.model.pauseScreen`), 5000, 'pause menu');
    const veto = await ev(`__saves.canSave()`);
    if (veto) {
      row.error = `cannot save: ${veto}`;
      note(row.error);
      await press('Escape');
      return row;
    }
    const manual = `__saves.list().then((l) => l.filter((s) => s.kind === 'manual'))`;
    const prior = (await ev(`${manual}.then((l) => l.length)`)) ?? 0;
    const before = await ev(SNAP);
    await menuChoose(`it.action?.kind === 'openSaves' && it.action.screen === 'saveGame'`);
    await sleep(500);
    const scr = await ev(`__menu.frontend.screenId`);
    // First item of the save list is the new slot.
    await menuChoose(`it.action?.kind === 'saveTo' && !it.action.id`).catch(async () => menuChoose(`it.action?.kind === 'saveTo'`));
    const saved = await waitFor(async () => (await ev(`${manual}.then((l) => l.length)`)) > prior && (await ev(`${manual}.then((l) => l.sort((a, b) => b.createdAt - a.createdAt)[0]?.id)`)), 10_000, 'save written').catch(() => null);
    if (!saved) {
      row.error = 'no save written';
      note(row.error);
      return row;
    }
    row.id = saved;
    note(`saved "${saved}" from ${scr}`);
    // Back to the game, then change the state: walk away and wait.
    for (let n = 0; n < 4 && (await ev(`__menu.isPaused`)); n++) {
      await press('Escape');
      await sleep(300);
    }
    await sleep(3000);
    // Pause -> Load Game -> the save (confirm).
    await press('Escape');
    await waitFor(() => ev(`__menu.isPaused`), 5000, 'pause menu');
    await menuChoose(`it.action?.kind === 'openSaves' && it.action.screen === 'loadGameInGame'`);
    await sleep(500);
    await menuChoose(`it.action?.kind === 'loadSave' && it.action.id === ${JSON.stringify(saved)}`);
    await sleep(400);
    if (await ev(`__menu.frontend.stack.at(-1)?.screen.id === 'confirmLoadSave'`)) await menuChoose(`it.action?.kind === 'loadSave' && it.action.confirmed`);
    await waitFor(async () => !(await ev(`__menu.isPaused`)) && (await ev(`!!window.__world?.world && __world.world.time > 0.3`)), 60_000, 'loaded');
    await sleep(1500);
    await ensurePage();
    const after = await ev(SNAP);
    row.diff = diffSnap(before, after);
    row.ok = row.diff.length === 0;
    note(`load "${saved}": ${row.ok ? 'state restored' : 'DIFF ' + row.diff.join(' | ')}`);
    return row;
  };

  // Objective checks after a step.
  const checkExpect = async (exp, cpBefore) => {
    const out = [];
    if (!exp) return out;
    for (const u of exp.played ?? []) if (!(await ev(`!!__world.world.get(${u})?.s.played`))) out.push(`sequence #${hex(u)} not played`);
    for (const u of exp.destroyed ?? []) if (!(await ev(`!!__world.world.get(${u})?.destroyed`))) out.push(`#${hex(u)} not destroyed`);
    for (const u of exp.open ?? []) if (!(await ev(`!!__world.world.get(${u})?.s.open`))) out.push(`#${hex(u)} not open`);
    for (const u of exp.taken ?? []) if (!(await ev(`!!__world.world.get(${u})?.s.taken`))) out.push(`#${hex(u)} not taken`);
    for (const u of exp.unlocked ?? []) if (!(await ev(`!!__world.world.get(${u})?.s.unlocked`))) out.push(`#${hex(u)} still locked`);
    // Actors that must be dead / broken (5b's projectors: Animating Statics run as actors).
    for (const u of exp.dead ?? []) if (await ev(`!!__actors.manager.get(${u})?.alive`)) out.push(`#${hex(u)} still alive`);
    // [actor uid, [x, y, z], tolerance m]: where a character must be (alive, not fallen away).
    for (const [u, at, tol] of exp.actorAt ?? []) {
      const q = await ev(`(() => { const a = __actors.manager.actors.find((x) => x.entity?.uid === ${u}); if (!a) return null; const p = a.motor.position; return [p.x, p.y, p.z]; })()`);
      const d = q && Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
      if (!q) out.push(`#${hex(u)} gone`);
      else if (d > tol) out.push(`#${hex(u)} at ${q.map((v) => v.toFixed(2))} (${d.toFixed(2)} m from ${at})`);
    }
    // Characters removed from the level (5a: Carmen when her vision ends) / woken (out of their DormantBehavior).
    for (const u of exp.gone ?? []) if (await ev(`!!__actors.manager.get(${u})`)) out.push(`#${hex(u)} still there`);
    for (const u of exp.awake ?? []) if (await ev(`(__actors.manager.get(${u})?.behavior?.kind ?? 'dormant') === 'dormant'`)) out.push(`#${hex(u)} not woken`);
    // Characters that must be alive (the 2 Cellblocks inmate).
    for (const u of exp.actorAlive ?? []) if (!(await ev(`!!__actors.manager.get(${u})?.alive`))) out.push(`#${hex(u)} dead (${await ev(`JSON.stringify((__pt.allyDmg ?? []).filter((x) => x.uid === '${hex(u)}').slice(-4))`).catch(() => '')})`);
    // [sequence, minimum seconds its watched actor is on screen] (stroll watchScenes).
    for (const [u, min] of exp.scenes ?? []) {
      const r = cur?.scenes?.[u];
      if (!r || r.start == null) out.push(`sequence #${hex(u)} not played`);
      else if (r.seen < min) out.push(`#${hex(r.uid)} on screen ${r.seen.toFixed(2)} s in #${hex(u)} (want >= ${min})`);
    }
    // Characters a sequence must find alive when it starts (1a "Gaurd" #218: the guard 609f runs
    // to the bars and is killed in the scene, not before it).
    for (const [seq, u] of exp.aliveAtStart ?? []) {
      const r = await ev(`(window.__ptSceneStart ?? {})[${seq}]?.[${u}] ?? null`);
      if (r !== true) out.push(`#${hex(u)} ${r === false ? 'already dead' : 'not seen'} when sequence #${hex(seq)} started`);
    }
    // A placed Sound Effect started during the step with a voice of that sound in the mixer (a
    // voice dropped for want of a free one does not count).
    for (const [u, key] of exp.heard ?? []) {
      const r = await ev(`(() => ({ started: !!__world.world.get(${u})?.s.playing, voice: !!window.__ptHeard?.has('${key}'), n: __audio.voices.size }))()`);
      if (!r.started || !r.voice) out.push(`Sound Effect #${hex(u)} ${key} not heard (started ${r.started}, voice ${r.voice}, ${r.n} voices now)`);
    }
    if (exp.weapon && (await ev(`__weapons.persist.current`)) !== exp.weapon) out.push(`weapon ${await ev(`__weapons.persist.current`)} (want ${exp.weapon})`);
    // checkpoint: true = one taken during the step; a uid = that Autosave taken by now (it can
    // fire during the step before: 1a 8397 on the way out of the sally port booth, 1b 8339 as the
    // arena ends, 833b on the clamber).
    // (A transition's checkpoint comes two settle frames after its arrival cinematic: up to 10 s.)
    // A checkpoint asked for is taken once no cinematic runs (save manager tick): one asked for
    // during a vision or a scene (1a's cp3: the insanity vision on the way) comes when it ends.
    // Waited for while it is still pending, up to 90 s.
    const cpWait = async (fn) => (await waitFor(fn, 10_000, 'checkpoint').catch(() => false)) || (await waitFor(async () => fn() || !(await ev(`!!window.__saves?.pending`).catch(() => false)), 80_000, 'pending checkpoint').catch(() => false), fn());
    if (exp.checkpoint === true && !(await cpWait(() => checkpointsTaken() > cpBefore))) out.push('no checkpoint taken');
    // The Autosave is taken a moment after its Detector (two settle frames, none while a
    // cinematic runs, then the capture): wait for it up to 10 s.
    if (typeof exp.checkpoint === 'number') {
      const line = `[save] checkpoint (Autosave #${hex(exp.checkpoint)})`;
      if (!(await cpWait(() => logs.some((l) => l.includes(line))))) out.push(`checkpoint #${hex(exp.checkpoint)} not taken`);
    }
    if (exp.level && stem(await levelNow()) !== exp.level) out.push(`level ${stem(await levelNow())} (want ${exp.level})`);
    return out;
  };

  // ------------------------------------------------------------------------------------------
  // Boot: gate -> logos -> copyright -> main menu -> New Game (Medium)

  console.log(`playthrough on ${base}`);
  const t0 = Date.now();
  // --level 0 (block owned by the Prelude route): the Prelude is New Game's level once the game
  // was finished (Main Menu p18 instead of p17 while engine flag 0x400 is set; GUI Game Finished
  // sets it, src/app/menu/profile.ts). The player profile is given that unlock (logged) and the
  // run boots through the menus as a player's New Game does. --direct deep-links it instead.
  const preludeViaMenu = startLevel === '0' && !has('--direct');
  if (startLevel && !preludeViaMenu) {
    // A level that is entered through a transition (ARRIVALS) starts in the level before it and
    // fires that level's exit at once: the arrival (spawn point, Level Transition Msg Handlers,
    // carried companions) is the game's own. --direct starts the level itself instead.
    const arrive = !has('--direct') && ARRIVALS[startLevel]?.from ? ARRIVALS[startLevel] : null;
    /** A level started on its own with a kit (level 7: its Player object's pickups). */
    const directKit = !ARRIVALS[startLevel]?.from && KITS[ARRIVALS[startLevel]?.kit];
    const first = arrive ? arrive.from : (ARRIVALS[startLevel]?.level ?? startLevel);
    /** The level arrived in (r1b / r1a: a chapter 1 level revisited). */
    const target = arrive?.level ?? startLevel;
    const path = levelPath(first);
    await send('Page.navigate', { url: `${base}/?difficulty=${DIFFICULTY}&level=${encodeURIComponent(path).replace(/%2F/g, '/')}${EXTRA_QUERY ? `&${EXTRA_QUERY}` : ''}` });
    await waitFor(() => ev(`!!window.__world?.world && __world.world.time > 1 && !!window.__actors?.combat`), 600_000, `level ${first}`); // a loaded machine (several runs) takes minutes
    shortcut('deep link', `started in ${first} through ?level= (no menus, no carried inventory)`);
    if (arrive) {
      // The kit is given in the level before, so it is carried through the transition and is in
      // the arrival checkpoint (given after the arrival, a death restored the level without it).
      if (arrive.kit && KITS[arrive.kit] && !opt('--save')) {
        const kit = KITS[arrive.kit];
        await ev(`(() => { const s = __weapons.service; for (const [id, n] of ${JSON.stringify(kit.items)}) s.give(id, n); return 1; })()`);
      }
      // --visited <capture>: the levels a capture holds (their state when the player left them) go
      // into the session, as a player's earlier visits (a revisit restores them).
      if (opt('--visited')) {
        const cap = JSON.parse(readFileSync(opt('--visited'), 'utf8'));
        const keys = await ev(`(() => { Object.assign(__saves.session.levels, ${JSON.stringify(cap.levels ?? {})}); return Object.keys(__saves.session.levels); })()`);
        shortcut('visited', `level states from ${opt('--visited')} put into the session as earlier visits: ${keys.join(', ')}`);
      }
      // What the level before posts on the way out (its Level Transition Msg Handlers).
      for (const [h, m, from] of arrive.mail ?? []) {
        await ev(`__world.world.send(${h}, ${m}, ${from})`);
        shortcut('mail', `message ${m} sent to Level Transition Msg Handler #${hex(h)} as from #${hex(from)} (what the way out of ${arrive.from} sends)`);
      }
      shortcut('transition', `Level Transition #${hex(arrive.transition)} of ${arrive.from} fired at once through the campaign service: arriving in ${target} as from ${arrive.from}`);
      await ev(`__campaign.service.fireTransition(${arrive.transition}, true)`);
      await waitFor(async () => stem(await levelNow()).startsWith(`${target} `) && (await ev(`!!window.__world?.world && __world.world.time > 1 && !!window.__actors?.combat`).catch(() => false)), 180_000, `level ${target}`);
    }
    // What a player arriving from the previous level would carry at least: the shiv (1a).
    if (await ev(`(() => { const s = __weapons.service; s.give('4:79'); return s.equip('4:79'); })()`)) shortcut('deep link', 'the shiv given through services.weapons.give');
    // --save <file>: a state captured with the control server's /capture (exploring a later part
    // of a level without playing up to it; logged).
    if (opt('--save')) {
      const data = readFileSync(opt('--save'), 'utf8');
      shortcut('save', `state restored from ${opt('--save')} (captured during an earlier run)`);
      await ev(`(async () => { await __saves.host.restore(${data}); return 1; })()`);
      await sleep(1500);
      await waitFor(() => ev(`!!window.__world?.world && __world.world.time > 0.5 && !!window.__actors?.combat`), 180_000, 'restored level');
    } else if (directKit) {
      if (opt('--visited')) {
        const cap = JSON.parse(readFileSync(opt('--visited'), 'utf8'));
        const keys = await ev(`(() => { Object.assign(__saves.session.levels, ${JSON.stringify(cap.levels ?? {})}); return Object.keys(__saves.session.levels); })()`);
        shortcut('visited', `level states from ${opt('--visited')} put into the session as earlier visits: ${keys.join(', ')}`);
      }
      await ev(`(() => { const s = __weapons.service; for (const [id, n] of ${JSON.stringify(directKit.items)}) s.give(id, n); s.equip(${JSON.stringify(directKit.equip)}); return 1; })()`);
      shortcut('deep link', `the level's start kit (${ARRIVALS[startLevel].kit}) given through services.weapons.give: ${directKit.items.map(([id, n]) => `${id} x${n}`).join(', ')}`);
    } else if (arrive?.kit && KITS[arrive.kit]) {
      const kit = KITS[arrive.kit];
      // Given before the transition (above); given again here only if it was not carried over.
      await ev(`(() => { const s = __weapons.service; if (!s.weapons.length) for (const [id, n] of ${JSON.stringify(kit.items)}) s.give(id, n); s.equip(${JSON.stringify(kit.equip)}); return 1; })()`);
      shortcut('deep link', `carried kit (${arrive.kit}) given through services.weapons.give in ${arrive.from} before its transition: ${kit.items.map(([id, n]) => `${id} x${n}`).join(', ')}`);
    }
  } else {
  if (preludeViaMenu) {
    await send('Page.navigate', { url: `${base}/${EXTRA_QUERY ? `?${EXTRA_QUERY}` : ''}` });
    await waitFor(() => ev(`!!window.__menu`), 300_000, 'front end');
    await ev(`(() => { localStorage.setItem('suffering.profile.v1', JSON.stringify({ pages: [], prelude: true })); return 1; })()`);
    shortcut('profile', 'the player profile has the prelude unlock (as after Game Finished: engine flag 0x400), so New Game starts Main Menu p18, the Prelude');
  }
  await send('Page.navigate', { url: `${base}/${EXTRA_QUERY ? `?${EXTRA_QUERY}` : ''}` });
  await waitFor(() => ev(`window.__menu?.frontend.currentMode === 'gate' && __menu.frontend.gateReady`), 300_000, 'start gate');
  await click(640, 360);
  const movie = await waitFor(() => ev(`(() => { const m = document.querySelector('video'); const fe = __menu.frontend.currentMode; return (m && !m.paused && m.currentTime > 0.2) ? 'movie' : fe === 'copyright' || fe === 'menu' ? fe : ''; })()`), 30_000, 'logo movie or copyright');
  if (movie === 'movie') {
    await sleep(1500);
    await press('Escape');
  }
  await waitFor(() => ev(`__menu.frontend.currentMode === 'menu' && __menu.frontend.screenId === __menu.model.mainScreen`), 30_000, 'main menu');
  console.log(`  main menu after ${((Date.now() - t0) / 1000).toFixed(1)} s (logo movie ${movie === 'movie' ? 'skipped' : 'absent'})`);
  await shot('00-main-menu');
  // New Game (the first item): Enter once the items are up; again if the menu was not ready.
  await waitFor(() => ev(`!__menu.frontend.itemsHidden`), 15_000, 'main menu items');
  await sleep(800);
  for (let n = 0; n < 4 && (await ev(`__menu.frontend.screenId`)) !== 'difficulty'; n++) {
    await press('Enter');
    await waitFor(() => ev(`__menu.frontend.screenId === 'difficulty'`), 4000, 'difficulty menu').catch(() => null);
  }
  await waitFor(() => ev(`__menu.frontend.screenId === 'difficulty' && !__menu.frontend.itemsHidden`), 15_000, 'difficulty menu');
  await sleep(500);
  // Move the selection to the difficulty asked for (Medium by default) with the arrow keys.
  const selJs = `__menu.frontend.stack.at(-1).screen.items[__menu.frontend.stack.at(-1).sel].action`;
  for (let n = 0; n < 6; n++) {
    const sel = await ev(selJs);
    if (sel?.difficulty === DIFFICULTY) break;
    await press(typeof sel?.difficulty === 'number' && sel.difficulty > DIFFICULTY ? 'ArrowUp' : 'ArrowDown');
    await sleep(250);
  }
  const sel = await ev(selJs);
  if (sel?.difficulty !== DIFFICULTY) throw new Error(`difficulty item is ${JSON.stringify(sel)}, expected ${DIFFICULTY_NAMES[DIFFICULTY]}`);
  await press('Enter');
  await sleep(800);
  if (await ev(`__menu.frontend.itemsHidden`)) await press('Escape'); // transition clip
  await waitFor(() => ev(`__menu.inGame && !__menu.frontend.visible && !!window.__world?.world && !!window.__actors?.combat`), 420_000, preludeViaMenu ? 'level 0' : 'level 1a');
  if (preludeViaMenu && !stem(await levelNow()).startsWith('0 ')) throw new Error(`New Game with the prelude unlocked started ${stem(await levelNow())}, not the Prelude`);
  console.log(`  ${stem(await levelNow())} loaded after ${((Date.now() - t0) / 1000).toFixed(1)} s, difficulty ${await ev(`__campaign.state.difficulty ?? __campaign.difficulty?.level ?? '?'`).catch(() => '?')}`);
  }
  // --save without --level: a captured state restored in the menu session (New Game, then the
  // capture), so the front end's own screens (Game Finished, the credits) follow (logged).
  if (!startLevel && opt('--save')) {
    const data = readFileSync(opt('--save'), 'utf8');
    shortcut('save', `state restored from ${opt('--save')} in the menu session (captured during an earlier run)`);
    await ev(`(async () => { await __saves.host.restore(${data}); return 1; })()`);
    await sleep(1500);
    // (1a's world answers until the capture's level replaces it.)
    const want = JSON.stringify(JSON.parse(data).levelPath ?? '');
    await waitFor(() => ev(`!!window.__world?.world && __world.world.opts.levelPath === ${want} && __world.world.time > 0.5 && !!window.__actors?.combat && __actors.combat.health > 0`), 180_000, 'restored level');
  }
  await ensurePage();
  if (godMode) shortcut('invulnerable', '--invulnerable');
  if (IGNORE_PLAYER) shortcut('ignore-player', '--ignore-player: enemies ignore the player (port option, ?ignorePlayer=1); not a valid campaign result');
  // --reputation <n>: the player's reputation set (after a --save restore: the capture's own is
  // replaced), to play an ending or a reputation scene of that standing (logged).
  if (opt('--reputation') !== undefined) {
    const rep = Number(opt('--reputation'));
    const was = await ev(`__insanity.model.s.reputation`);
    await ev(`(() => { __insanity.model.s.reputation = ${rep}; return 1; })()`);
    shortcut('reputation', `--reputation: ${was} -> ${rep} through __insanity.model.s.reputation`);
  }
  // Reflex, all run long: while a creature holds the player (a Mainliner riding him, a Nooseman's
  // rope) mash Fire and Jump, the struggle presses (specials/hold.ts), about 14 a second, whatever
  // the route is doing (a step's waits and checks must not leave him defenceless). Fire goes
  // through services.weapons.fire as every shot of the run; Jump is the Space key.
  let struggles = 0;
  (async () => {
    for (;;) {
      await sleep(70);
      if (!(await ev(`!!window.__player?.attackOverride`).catch(() => false))) continue;
      if (!struggles++) shortcut('api', 'struggle presses: Fire through services.weapons.fire, Jump with Space');
      await ev(`(() => { __weapons.service.fire(); return 1; })()`).catch(() => {});
      await press('Space', 40);
    }
  })();

  // ------------------------------------------------------------------------------------------
  // Route

  let start = fromStep ? ROUTE.findIndex((s) => s.id === fromStep) : startLevel ? ROUTE.findIndex((s) => s.id.startsWith(`${startLevel}.`)) : 0;
  if (start < 0) throw new Error(`no step ${fromStep}`);
  const stop = toStep ? ROUTE.findIndex((s) => s.id === toStep) : ROUTE.length - 1;
  let deaths = 0;
  /** Checkpoints taken before the running step (the death retry: one taken during it). */
  let stepCpBefore = -1;
  let lastLogN = logs.length;
  // GET /step?id=<step id> on the control server runs one more step (--keep).
  stepHook = async (id) => {
    const i = ROUTE.findIndex((s) => s.id === id);
    if (i < 0) return `no step ${id}`;
    await runStep(i);
    return report.steps.at(-1);
  };
  const diedAt = new Set();
  for (let i = start; i <= stop; i++) {
    i = await runStep(i);
    if (DEATHS.has(ROUTE[i]?.id) && !diedAt.has(ROUTE[i].id)) i = await dieAndRestore(i);
  }
  /**
   * --deaths: kill the player after step i and let the game restore its last checkpoint. The
   * restored level must equal the one captured with the checkpoint (tools/playthrough-restore.js)
   * and the player controller must be free; the route goes on from the step that took the
   * checkpoint (no invulnerability: the steps after it are played as a player would again).
   */
  async function dieAndRestore(i) {
    const step = ROUTE[i];
    diedAt.add(step.id);
    cur = { id: `${step.id}.die`, obj: 'die here: the game restores its last checkpoint exactly as it was taken', ok: true, notes: [], shortcuts: [], problems: [] };
    report.steps.push(cur);
    console.log(`  [${cur.id}] ${cur.obj}`);
    const ts = Date.now();
    problems.length = 0;
    try {
      await hold(false);
      await ensurePage();
      const cp = await ev(`({ at: __saves.checkpoint?.createdAt ?? 0, snapAt: window.__ptRestore?.state.cpAt ?? 0, n: ${checkpointsTaken()} })`);
      if (!cp.at) cur.problems.push('no checkpoint to restore');
      else if (cp.snapAt !== cp.at) cur.notes.push('the checkpoint was taken before the restore hooks: no state comparison');
      shortcut('die', 'killed through __actors.combat.damage (a deliberate death; invulnerability off)');
      const before = await ev(`(() => { window.__ptOldWorld = __world.world; __actors.combat.invulnerable = false; __actors.combat.damage(1e6); return __actors.combat.health; })()`);
      if (before > 0) cur.problems.push(`still alive after the killing blow (${before})`);
      await waitFor(() => ev(`!!window.__world?.world && window.__world.world !== window.__ptOldWorld && (window.__actors?.combat?.health ?? 0) > 0`), 60_000, 'the checkpoint restore after the death');
      if (cp.snapAt === cp.at) {
        await waitFor(() => ev(`!!window.__ptRestore.state.restored`), 15_000, 'the restored state');
        const d = await ev(`__ptRestore.diff()`);
        cur.restoreDiff = d;
        if (!d.sameCheckpoint) cur.problems.push('restored another checkpoint than the last one taken');
        if (d.hard.length) cur.problems.push(`restored level differs from the checkpoint (${d.hard.length}): ${d.hard.slice(0, 12).join('; ')}`);
        if (d.soft.length) note(`other differences (${d.soft.length}): ${d.soft.slice(0, 8).join('; ')}`);
      }
      const ctl = await ev(`__ptRestore.control()`);
      if (ctl.motionOverride || ctl.bodyYawLock !== null || ctl.attackOverride || !ctl.enabled) cur.problems.push(`player controller not released after the restore: ${JSON.stringify(ctl)}`);
      await ensurePage();
      if (godMode) await ev(`(() => { __actors.combat.invulnerable = true; return 1; })()`);
    } catch (e) {
      cur.problems.push(`error: ${e.message.split('\n')[0]}`);
    }
    if (problems.length) cur.problems.push(...problems.filter((p) => !/^warn: /.test(p)).slice(0, 6));
    cur.ms = Date.now() - ts;
    cur.ok = cur.problems.length === 0;
    if (!cur.ok) failures++;
    console.log(`     ${cur.ok ? 'ok' : 'PROBLEMS: ' + cur.problems.join(' | ')} (${(cur.ms / 1000).toFixed(1)} s)`);
    // On from the step that took the restored checkpoint: the last Autosave taken, else the last
    // step that expects a checkpoint (level start, transition).
    let back = ROUTE.findLastIndex((s, k) => k <= i && s.expect?.checkpoint);
    const lastCp = logs.filter((l) => /\[save\] checkpoint \(Autosave #/.test(l)).at(-1)?.match(/#([0-9a-f]+)/)?.[1];
    const byUid = lastCp ? ROUTE.findLastIndex((s, k) => k <= i && s.expect?.checkpoint === parseInt(lastCp, 16)) : -1;
    if (byUid >= 0) back = byUid;
    if (back >= 0) note(`the route goes on after ${ROUTE[back].id}`);
    return Math.max(back, start - 1);
  }
  async function runStep(i) {
    stepCpBefore = -1;
    const step = ROUTE[i];
    cur = { id: step.id, obj: step.obj, ok: true, notes: [], shortcuts: [], problems: [] };
    report.steps.push(cur);
    abortRun = false;
    console.log(`  [${step.id}] ${step.obj}`);
    const ts = Date.now();
    problems.length = 0;
    try {
      await ensurePage();
      // Out of a fight: back to human form (climbing, using and pushing need it).
      if (!(await inEndScreens())) await ev(`(() => { window.__ptAvoidWater = ${!!step.noWater}; window.__ptSaveRounds = ${!!step.saveRounds}; window.__ptFloor = ${step.sea ? step.sea[0] : 'null'}; window.__ptSpare = ${JSON.stringify(step.spare ?? [])}; return 1; })()`).catch(() => {});
      fightFloor = step.sea ? step.sea[0] : null;
      if (step.do !== 'arena' && !(await inEndScreens())) await changeBack('the fight is over');
      const cpBefore = checkpointsTaken();
      stepCpBefore = cpBefore;
      // expect.aliveAtStart: who of a sequence's characters was alive when it started (the
      // world's sequence observer, wrapped once per world).
      if (!(await inEndScreens())) await ev(`(() => { const w = __world?.world; const o = w?.stompObserver; if (!o || o.__ptStart) return 0; const b = o.begin; o.begin = (run) => { const m = (window.__ptSceneStart ??= {}); m[run.uid] = Object.fromEntries(run.seq.tracks.map((t) => [t.uid, __actors.manager.get(t.uid)?.alive]).filter((x) => x[1] !== undefined)); return b.call(o, run); }; o.__ptStart = true; return 1; })()`).catch(() => {});
      // expect.heard: the sounds the mixer starts during the step (onPlay is not called for a
      // voice dropped because none was free).
      if (step.expect?.heard) await ev(`(() => { window.__ptHeard = new Set(); if (!__audio.__ptHeardHook) { const prev = __audio.onPlay; __audio.onPlay = (info, opts) => { window.__ptHeard?.add(info.key); return prev?.(info, opts); }; __audio.__ptHeardHook = true; } return 1; })()`).catch(() => {});
      // `unless` (JS): what the step does is done already (by another character): skipped.
      if (step.unless && (await ev(step.unless))) note(`skipped: already done (${step.unless})`);
      else switch (step.do) {
        case 'intro': {
          const c = await waitFor(() => ev(`__world.world.activeCutscenes().map((c) => c.name)[0] ?? null`), 20_000, 'opening cinematic').catch(() => null);
          note(`opening cinematic: ${c ?? 'none'}`);
          await sleep(step.watch * 1000);
          await shot(`${step.id}-watching`);
          await press('Enter');
          await waitFor(async () => !(await cinematic()), 30_000, 'control after the opening');
          break;
        }
        case 'stroll': {
          // A player's walk, not the planner's: W held with the gait he plays with (step.gait
          // 'walk' or 'run'), the view turned towards each point of `via` at a mouse-like rate
          // (step.turn rad/s) so corners are rounded and the view sweeps as by hand, a door that
          // stops him opened with E where he stands. Scenes met on the way are watched
          // (watchScenes: [sequence, actor, seconds]; expect.scenes checks the time on screen).
          for (const [seq, uid, secs] of step.watchScenes ?? []) await ev(`(() => { __pt.watchScene(${seq}, ${uid}, ${secs}); return 1; })()`);
          await ev(`(() => { __player.alwaysRun = ${step.gait !== 'walk'}; __pt.go(${JSON.stringify(step.via)}, ${step.tol ?? 0.6}, ${step.turn ?? 3.5}, 1.2); return 1; })()`);
          await hold(true);
          const end = Date.now() + (step.max ?? 60) * 1000;
          let opened = 0;
          const strip = {};
          while (Date.now() < end) {
            await sleep(80);
            await checkDeath();
            if (await cinematic()) {
              await hold(false);
              await waitCine();
              await hold(true);
              continue;
            }
            const s = await ev(`(() => ({ done: __pt.ap.done, stuck: __pt.ap.stuck, door: __pt.ap.stuck >= 1 ? __pt.blockingDoor() : null, scene: Object.values(__pt.sceneWatch).find((r) => r.start != null && !r.done)?.seq ?? 0 }))()`);
            // With --shots: a strip of the player's view while a watched scene runs (6 frames each).
            if (s.scene && shotsDir && (strip[s.scene] ?? 0) < 6) await shot(`${step.id}-${hex(s.scene)}-f${(strip[s.scene] = (strip[s.scene] ?? 0) + 1)}`);
            if (s.done) break;
            if (s.door && opened < 3) {
              await hold(false);
              // Face the door's handle side as a player does (the original's fit test).
              await ev(`(() => { __pt.ap.active = false; const c = __pt.useAim(parseInt('${s.door}', 16)); __pt.aimAt(c[0], c[1], c[2]); return 1; })()`);
              await sleep(250);
              await press('KeyE');
              await sleep(1200);
              opened++;
              await ev(`(() => { __pt.ap.stuck = 0; __pt.ap.active = true; return 1; })()`);
              await hold(true);
              continue;
            }
            if (s.stuck >= 3) break;
          }
          await hold(false);
          const st = await ev(`(() => { __pt.ap.active = false; __player.alwaysRun = true; return __pt.state(); })()`);
          if (opened) note(`opened ${opened} door(s) with E on the way`);
          const to = step.via.at(-1);
          const d = Math.hypot(st.p[0] - to[0], st.p[2] - to[2]);
          if (d > (step.tol ?? 0.6) + 0.6) cur.problems.push(`did not arrive (${d.toFixed(2)} m away)`);
          await sleep((step.settle ?? 0) * 1000);
          for (const [seq, uid] of step.watchScenes ?? []) {
            const r = await ev(`__pt.sceneWatch[${JSON.stringify(`${seq}:${uid}`)}] ?? null`);
            (cur.scenes ??= {})[seq] = r;
            note(`#${hex(seq)}: #${hex(uid)} on screen ${r?.start == null ? '- (not played)' : `${r.seen.toFixed(2)} s of ${r.secs} s${r.first ? `, first at ${r.first.t} s (${r.first.d} m)` : ''}`}`);
          }
          break;
        }
        case 'walk': {
          // `run: true`: run past what attacks (the 2 Cellblocks steam-pipe yard), no stopping to fight.
          // `drop`: the deepest drop the planner may take (m; default 1.3, fall damage from 6.5).
          const r = await walk(step.to, step.tol ?? 0.6, step.max ?? 120, { noFight: !!step.run, drop: step.drop });
          // `relocates`: a cinematic on the way leaves the player elsewhere (5b's "Camera" 2bed
          // ends with Torque dropped through a hole to the floor below).
          if (!r.arrived && !(step.relocates && cur.cineSeen)) cur.problems.push(`did not arrive (${r.d} m away)`);
          break;
        }
        case 'goto': {
          // Walk; where the route on foot is not known (a puzzle not scripted here), teleport and
          // say so.
          const r = await walk(step.to, step.tol ?? 0.6, step.max ?? 120);
          if (!r.arrived) {
            shortcut('teleport', `${step.why ?? 'no walking route found'} (${r.d} m short)`);
            await ev(`(() => { __player.teleport({ x: ${step.to[0]}, y: ${step.to[1]}, z: ${step.to[2]} }); return 1; })()`);
            await sleep(800);
          }
          break;
        }
        case 'look':
          await ev(`(() => { __pt.aimAt(${step.at.join(',')}); return 1; })()`);
          await sleep(600);
          break;
        case 'vision': {
          // 10's dock visions: stand in the Detector (`stand`) as a human and keep looking at the
          // Visiblity Message Filter (`at`) until `until` holds. A blow, a hold or the sea moves
          // the player off the spot: back to it and look again (a single look was missed, e17).
          // `ready`: the logic has enabled the Detectors (the wave's Count Down / Timer).
          if (step.ready && !(await waitAlive(step.ready, step.readyTimeout ?? 30, `${step.id} ready`))) break;
          const end = Date.now() + (step.timeout ?? 60) * 1000;
          let moves = 0;
          while (Date.now() < end && !abortRun && !(await ev(step.until))) {
            await checkDeath();
            if (await cinematic()) {
              await waitCine();
              continue;
            }
            await outOfSea(step);
            await changeBack('a vision needs the human form');
            const far = await ev(`(() => { const p = __player.position; return Math.hypot(p.x - ${step.stand[0]}, p.z - ${step.stand[2]}) > ${step.tol ?? 1.2} || Math.abs(p.y - ${step.stand[1]}) > 1; })()`);
            if (far) {
              moves++;
              await walk(step.stand, step.tol ?? 1.2, 20, { drop: step.drop });
            }
            await ev(`(() => { __pt.ap.active = false; __pt.ap.follow = 0; __pt.aimAt(${step.at.join(',')}); return 1; })()`);
            await sleep(500);
          }
          if (moves) note(`back onto the vision spot ${moves} time(s)`);
          if (!(await ev(step.until))) cur.problems.push(`vision: not seen in ${step.timeout ?? 60} s (${step.until})`);
          break;
        }
        case 'arena': {
          const end = Date.now() + (step.timeout ?? 300) * 1000;
          let done = false;
          const skipPrey = new Set();
          const preyMiss = new Map();
          while (Date.now() < end && !abortRun && !(done = !!(await ev(step.until)))) {
            await checkDeath();
            if (await cinematic()) {
              await waitCine();
              continue;
            }
            await outOfSea(step);
            // Insanity full: transform (Q needs pointer lock: the model's own call). Meter run
            // dry while transformed: change back (Q again; the original keeps the creature form at
            // an empty meter, draining health, until the player presses Insanity).
            // (Not with a companion close by: the creature's blows hit him too, 2 Cellblocks' inmate.)
            if (await ev(`(() => { const m = window.__insanity?.model; const p = __player.position; const ally = __actors.manager.actors.some((a) => a.alive && (!a.hostile || __pt.isCompanion(a)) && !a.template && a.entity?.className === 'Unspeakable NPC' && Math.hypot(a.position.x - p.x, a.position.z - p.z) < 30); return !!m && !ally && m.form === 'human' && m.s.meter >= m.max - 0.01; })()`)) {
              shortcut('api', 'insanity transform through __insanity.transform (the Q key needs pointer lock)');
              await ev(`__insanity.transform()`);
              await sleep(1500);
            } else if (await ev(`(() => { const m = window.__insanity?.model; return !!m && m.form === 'creature' && m.s.meter <= m.max * 0.05; })()`)) await changeBack('the meter ran dry');
            // `hold` (m): the fight is kept to the stand's surroundings: only creatures within
            // that many metres of it are engaged, and the player goes back when farther (not
            // after creatures across a fence or in a pit: 3a's west yard).
            let area = null;
            if (step.hold) {
              area = [step.stand[0], step.stand[2], step.hold];
              if (await ev(`(() => { const p = __player.position; return Math.hypot(p.x - ${step.stand[0]}, p.z - ${step.stand[2]}) > ${step.hold}; })()`)) await backToStand(step, area);
            }
            const swings = await fight(15, true, false, null, area);
            // A creature in the sea (`sea`): no blade reaches it and walking after it is walking
            // off the dock: shot from the edge while it is in sight (it keeps the wave's Count
            // Down up otherwise: e17's Mainliner b2f).
            if (!swings && step.sea) {
              const wet = await ev(`(() => { const p = __player.position; const a = __actors.manager.actors.find((a) => !a.template && a.alive && a.hostile && a.ch.root.visible && a.motor.position.y < ${step.sea[0]} && Math.hypot(a.motor.position.x - p.x, a.motor.position.z - p.z) < 30); return a ? a.id : 0; })()`);
              if (wet) {
                let shots = 0;
                for (let k = 0; k < 15; k++) {
                  if (!(await ev(`(() => { const a = __actors.manager.actors.find((x) => x.id === ${wet}); if (!a?.alive || !__pt.canShoot(a.id)) return false; const q = a.motor.position; __pt.aimAt(q.x, q.y + 1.0, q.z); return true; })()`))) break;
                  await sleep(80);
                  if (await ev(`__pt.attack(${wet})`)) shots++;
                  await sleep(250);
                }
                if (shots) note(`shot ${shots} time(s) at a creature in the sea`);
                if (shots) continue;
              }
            }
            if (!swings) {
              // Nothing comes at the player: go to the nearest creature that is up (a copy idle in
              // the pit or on a ledge), else back to the stand.
              const prey = await ev(`(() => { const p = __player.position; const skip = new Set(${JSON.stringify([...skipPrey])}); let best = null, bd = 45; for (const a of __actors.manager.actors) { if (a.template || !(a.spawned || ${JSON.stringify(step.prey ?? [])}.includes(a.entity?.uid)) || a.health <= 0 || a.state === 'dead' || !a.ch.root.visible || a.dormantHidden || !a.hostile || skip.has(a.id)) continue; const q = a.motor.position; if (Math.abs(q.y - ${step.stand[1]}) > ${step.preyDy ?? 1e9}) continue; if (${step.preyR ? 1 : 0} && Math.hypot(q.x - ${step.stand[0]}, q.z - ${step.stand[2]}) > ${step.preyR ?? 0}) continue; const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z); if (d < bd) (bd = d), (best = { id: a.id, uid: a.entity?.uid ?? 0, cls: a.entity?.className ?? '', st: a.state, hp: a.health, pos: [q.x, q.y, q.z] }); } return best; })()`);
              if (prey) {
                // (Fighting what attacks on the way: a copy that comes down while the player walks
                // to another is fought, not walked through. With walkRaw the 1b arena's copies cut
                // the player down from behind on those walks, runs b1 / h1.)
                const r = await walk(prey.pos, 1.2, 25, { area });
                // Out of reach (a ledge, a hole) or not taking hits: leave it for a while.
                const hp = await ev(`__actors.manager.actors.find((a) => a.id === ${prey.id})?.health ?? 0`);
                // (No path gets within 5 m of it: left alone at once. The 1b arena's copies up on
                // the wall tops, 6..7 m beyond any path, come down by themselves.)
                if (!r.arrived && r.plan && !r.plan.ok && r.plan.rem > 5) preyMiss.set(prey.id, 2);
                else if (!r.arrived || hp >= prey.hp) preyMiss.set(prey.id, (preyMiss.get(prey.id) ?? 0) + 1);
                if ((preyMiss.get(prey.id) ?? 0) >= 2 && !skipPrey.has(prey.id)) {
                  skipPrey.add(prey.id);
                  note(`left #${hex(prey.uid)} (${prey.cls}, ${prey.st}) at ${prey.pos.map((v) => v.toFixed(1))} alone: out of reach or taking no hits`);
                }
              }
              else {
                const far = await ev(`(() => { const p = __player.position; return Math.hypot(p.x - ${step.stand[0]}, p.z - ${step.stand[2]}) > 4 || Math.abs(p.y - ${step.stand[1]}) > 2; })()`);
                if (far) await backToStand(step, area);
                else await sleep(1000);
              }
            }
          }
          // (A timeout without `force` passed silently: 10's first dock wave ended with a Mainliner
          // left, so the vision after it never came.)
          if (!done && !step.force && !abortRun) cur.problems.push(`arena not finished in ${step.timeout ?? 300} s (${step.until})`);
          if (!done && step.force) {
            cur.problems.push(`not finished in ${step.timeout} s`);
            shortcut('logic', step.force.why);
            await ev(step.force.js);
            await sleep(3000);
            await waitCine();
          }
          break;
        }
        case 'use':
          if (step.goto) {
            const r = await walk(step.goto, 1.0, 120, { drop: step.drop });
            if (!r.arrived) {
              shortcut('teleport', `no walking route to #${hex(step.uid)} found (${r.d} m short)`);
              await ev(`(() => { __player.teleport({ x: ${step.goto[0]}, y: ${step.goto[1]}, z: ${step.goto[2]} }); return 1; })()`);
              await sleep(800);
            }
          }
          if (step.stand) await walk(step.stand, 0.35, 60);
          // The level before the first use: an exit's transition (1b: Timer 79c2, 0.65 s) can be
          // over before the sleep below ends; read after it, the new level passed for "no change"
          // and E on the arrival side's own door (1c 52b6, back to 1b) bounced between the levels.
          const levelBefore = await levelNow();
          await useObj(step.uid, { wantOpen: !!step.expect?.open?.includes(step.uid), look: step.look ?? null });
          await sleep(1500);
          // An exit: try again (after dealing with what attacks) while no level change starts.
          for (let n = 0; n < 3 && step.transition; n++) {
            // A transition under way (the save manager's "level transition" veto, set when the
            // level is left) counts: a big level (5b) can take longer than this wait to load,
            // and a second use then reached for the old level's object.
            if (await waitFor(async () => (await levelNow()) !== levelBefore || (await ev(`!!window.__campaign?.service?.pending || ['level transition', 'no level'].includes(window.__saves?.canSave?.())`).catch(() => false)), 6000, 'transition').catch(() => false)) break;
            if ((await levelNow().catch(() => levelBefore)) !== levelBefore) break;
            await waitCine();
            await fight(10);
            note(`#${hex(step.uid)} used again (no level change yet)`);
            await useObj(step.uid);
            await sleep(1500);
          }
          break;
        case 'push': {
          // Stand behind the object, grab it (E), face the push direction (or the object for a
          // pull with S), hold the key until it is in place (step.until) or the time is up, let go
          // (E). A creature interrupting is fought, then the push is tried again from where the
          // object stands now.
          let stand = step.stand;
          // `rel` [dx, dz]: the stand taken from where the object is now (a correction after an
          // earlier push left it off its mark); `skipDone`: nothing to do when `until` holds.
          if (step.skipDone && step.until && (await ev(step.until))) {
            note(`#${hex(step.uid)} already in place`);
            break;
          }
          if (step.rel) {
            const c0 = await ev(`__pt.center(${step.uid})`);
            stand = [c0[0] + step.rel[0], stand[1], c0[2] + step.rel[1]];
          }
          const total = Date.now() + (step.secs ?? 3) * 3000;
          let moved = 0;
          for (let attempt = 0; attempt < 3 && Date.now() < total; attempt++) {
            await walk(stand, 0.3, 40);
            await ev(`(() => { const c = __pt.center(${step.uid}); __pt.aimAt(c[0], ${stand[1]} + 0.8, c[2]); return 1; })()`);
            await sleep(350);
            await press('KeyE');
            await sleep(300);
            const g = await ev(`__world.props.grabbed() ?? 0`);
            if (g !== step.uid) {
              note(`could not grab #${hex(step.uid)} (attempt ${attempt + 1})`);
              continue;
            }
            const key = step.key ?? 'KeyW';
            if (key === 'KeyW') await ev(`(() => { const p = __player.position; __pt.aimAt(p.x + ${step.dir[0]} * 5, p.y + 1.2, p.z + ${step.dir[1]} * 5); return 1; })()`);
            const p0 = await ev(`__pt.center(${step.uid})`);
            await keyEv('keyDown', key);
            const tEnd = Date.now() + (step.secs ?? 3) * 1000;
            while (Date.now() < tEnd) {
              await sleep(100);
              if (step.until && (await ev(step.until))) break;
              if (await ev(`__world.props.grabbed() === undefined`)) break;
              // Attacked while pushing: let go and fight first.
              if (await ev(`(() => { const t = __pt.engage(6); __pt.ap.follow = 0; return !!t && ['chase', 'attack', 'shoot'].includes(t.st); })()`)) break;
            }
            await keyEv('keyUp', key);
            if (await ev(`__world.props.grabbed() !== undefined`)) await press('KeyE');
            const p1 = await ev(`__pt.center(${step.uid})`);
            moved += Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
            await fight(30);
            if (!step.until || (await ev(step.until))) break;
            // Again from behind the object where it is now (the stand is on the far side for a
            // pull, the near side for a push).
            const back = key === 'KeyW' ? -1 : 1;
            stand = [p1[0] + step.dir[0] * 1.3 * back, stand[1], p1[2] + step.dir[1] * 1.3 * back];
          }
          note(`#${hex(step.uid)} moved ${moved.toFixed(2)} m`);
          if (step.until && !(await ev(step.until))) cur.problems.push(`#${hex(step.uid)} not where it should be`);
          break;
        }
        case 'wait':
          // `strip` (s, with --shots): a frame of what is on screen every that many seconds while
          // waiting (10's ending: the movie, the boat sequence, the picture), 30 at most.
          if (step.strip && shotsDir) {
            let n = 0;
            const stop = { done: false };
            const strip = (async () => {
              while (!stop.done && n < 30) {
                await sleep(step.strip * 1000);
                if (!stop.done) await shot(`${step.id}-f${String(++n).padStart(2, '0')}`).catch(() => null);
              }
            })();
            const ok = await waitAlive(step.until, step.timeout ?? 60, step.id);
            stop.done = true;
            await strip;
            if (!ok && step.force) {
              shortcut('logic', step.force.why);
              await ev(step.force.js);
              await sleep(3000);
            }
            break;
          }
          if (!(await waitAlive(step.until, step.timeout ?? 60, step.id)) && step.force) {
            shortcut('logic', step.force.why);
            await ev(step.force.js);
            await sleep(3000);
          }
          break;
        case 'pick':
          if (!(await pick(step.uid, step.aim)) && !step.optional) cur.problems.push(`#${hex(step.uid)} not picked up`);
          break;
        case 'pickNear': {
          // A pickup placed during play (no fixed uid): the nearest of the class to `at`.
          const uid = await ev(`(() => { let best = 0, bd = ${step.radius ?? 3}; for (const w of __world.world.of(${JSON.stringify(step.cls)})) { if (w.destroyed || w.s.taken) continue; const d = Math.hypot(w.pos[0] - ${step.at[0]}, w.pos[2] - ${step.at[2]}); if (d < bd) (bd = d), (best = w.uid); } return best; })()`);
          if (!uid) cur.problems.push(`no ${step.cls} near ${step.at.map((v) => v.toFixed(1))}`);
          else {
            // First as the player sees it from where he stands: drawn, lit, on screen (a frame).
            await ev(`(() => { const w = __world.world.get(${uid}); __pt.aimAt(w.pos[0], w.pos[1] + 0.1, w.pos[2]); return 1; })()`);
            await sleep(500);
            const v = await ev(`__pt.itemView(${uid})`);
            note(`#${hex(uid)} ${await ev(`__world.world.itemLabel(__world.world.get(${uid}))`)}: ${JSON.stringify(v)}`);
            if (!v.built || !v.inScene || !v.shown) cur.problems.push(`#${hex(uid)} not drawn (${JSON.stringify(v)})`);
            else if (v.baked && !(v.lit > 0)) cur.problems.push(`#${hex(uid)} drawn black (load-time colours 0)`);
            if (!v.onScreen) note(`#${hex(uid)} not in view from here`);
            await shot(`${step.id}-seen`);
            if (!(await pick(uid))) cur.problems.push(`#${hex(uid)} not picked up`);
          }
          break;
        }
        case 'break': {
          // `weapon`: the gun to break it with (a thin plank or a rope: the shotgun's spread
          // missed 5b's 29ee / 2b3f where single revolver shots break them; logged).
          await ev(`(() => { window.__ptBreakWeapon = ${JSON.stringify(step.weapon ?? null)}; return 1; })()`);
          if (step.weapon && (await ev(`__weapons.service.weapons.some((w) => w.id === ${JSON.stringify(step.weapon)} && w.clip + w.reserve > 0)`))) {
            shortcut('api', `${step.weapon} equipped through services.weapons.equip (the number keys need pointer lock)`);
            await ev(`(() => { __weapons.service.equip(${JSON.stringify(step.weapon)}); return 1; })()`);
            await sleep(1200);
          }
          // (Up to three rounds: a creature that comes at the player meanwhile is fought first.)
          for (let round = 0; round < 3 && !abortRun; round++) {
          if (round && step.uids.every(Boolean) && (await ev(`[${step.uids.join(',')}].every((u) => !!__world.world.get(u)?.destroyed)`))) break;
          if (round && step.until && (await ev(step.until))) break;
          if (round) await fight(20);
          for (let n = 0; n < 3 && !(await walk(step.from, 0.4, 60)).arrived; n++);
          for (const u of step.uids) {
            // No clear line from the spot (10: the pushed crate 318 can end between the player and
            // the valve 35a, which then never broke): a stand nearby that has one.
            if (!step.aim && !(await ev(`!!__world.world.get(${u})?.destroyed || __pt.lineTo(${u})`))) {
              const to = await ev(`__pt.lineStand(${u}, ${step.from[0]}, ${step.from[1]}, ${step.from[2]})`);
              if (to) {
                note(`#${hex(u)} out of the line of fire from ${step.from.join(', ')}: shot from ${to.map((v) => v.toFixed(1)).join(', ')}`);
                await walk(to, 0.3, 30);
              }
            }
            // `until` (JS): done another way (5b: the projector breaks before its Breakable).
            for (let n = 0; n < 30 && !abortRun && !(await ev(`!!__world.world.get(${u})?.destroyed`)) && !(step.until && (await ev(step.until))); n++) {
              // (A death here was not seen: the game restored its checkpoint while the loop went
              // on hitting, and the run counted none; 1b's locked hall door, shot from the hall.)
              await checkDeath();
              // What hunts the player meanwhile is fought first, then the spot walked to again
              // (1b's hall: shot, 15 a volley, while he hit the door 53c2, run s1).
              if (await ev(`(() => { const t = __pt.engage(14, false, true); __pt.ap.follow = 0; return !!t || __pt.exposed().length > 0; })()`)) {
                await fight(15, false, true);
                await walk(step.from, 0.4, 30);
              }
              // `aim`: the point to hit instead of the middle (a tall target reached by a blade).
              // Aim, let a frame draw the view there, then fire: a shot leaves along the drawn
              // camera, which still shows the last shot's kick in the frame the aim is set (5b's
              // lobby projector, 4 m up: every shotgun blast went over it).
              // Knocked off the spot (5b's theatre: raised Slayers and Mainliners): what attacks is
              // fought, then the spot walked to again.
              if (await ev(`(() => { const p = __player.position; return Math.hypot(p.x - ${step.from[0]}, p.z - ${step.from[2]}) > 3.2 || Math.abs(p.y - ${step.from[1]}) > 1; })()`)) {
                await fight(15, false, true);
                await walk(step.from, 0.4, 30);
              }
              await ev(`(() => { __pt.ap.follow = 0; const c = ${step.aim ? JSON.stringify(step.aim) : `__pt.center(${u})`}; __pt.aimAt(c[0], c[1], c[2]); return 1; })()`);
              await sleep(80);
              const r = await ev(`(() => { __pt.ap.follow = 0; const c = ${step.aim ? JSON.stringify(step.aim) : `__pt.center(${u})`}; __pt.aimAt(c[0], c[1], c[2]); return __pt.attack() ? 'hit' : __pt.allyInFront(3) ? 'ally' : ''; })()`);
              // A companion in the line of fire (2 Cellblocks: the inmate at the player's
              // shoulder): step aside, away from him, and aim again.
              if (r === 'ally') {
                const to = await ev(`(() => { const p = __player.position, c = __pt.center(${u}); let best = null; for (const a of __actors.manager.actors) { if (a.hostile || a.health <= 0 || !a.entity) continue; const q = a.motor.position; if (Math.hypot(q.x - p.x, q.z - p.z) > 4) continue; const dx = c[0] - p.x, dz = c[2] - p.z, l = Math.hypot(dx, dz) || 1; const sx = -dz / l, sz = dx / l; const side = (q.x - p.x) * sx + (q.z - p.z) * sz > 0 ? -1 : 1; best = [p.x + sx * side * 1.2, p.y, p.z + sz * side * 1.2]; } return best; })()`);
                if (to) await walkRaw(to, 0.3, 4);
              }
              await sleep(450);
            }
          }
          }
          break;
        }
        case 'shoot': {
          // Shoot a character the player cannot walk up to (2 Cellblocks: the gunner behind the
          // nest's window) from `from` until `until` holds; whatever comes at the player is
          // fought first.
          const end = Date.now() + (step.timeout ?? 60) * 1000;
          await walk(step.from, 0.4, 60);
          // `weapon`: one gun for it (2's gunner: single revolver shots, see the step).
          const equipStep = async () => {
            if (step.weapon && (await ev(`(() => { const w = __weapons; const g = w.service.weapons.find((x) => x.id === ${JSON.stringify(step.weapon)}); if (!g || g.clip + g.reserve <= 0 || w.persist.current === g.id) return false; w.service.equip(g.id); return true; })()`))) {
              shortcut('api', `${step.weapon} equipped through services.weapons.equip (the number keys need pointer lock)`);
              await sleep(1200);
            }
          };
          await equipStep();
          while (Date.now() < end && !(await ev(step.until))) {
            await checkDeath();
            if (await fight(10, false, true)) (await walk(step.from, 0.4, 30), await equipStep());
            // (Aim, let a frame draw it, then fire: see `break`.)
            await ev(`(() => { const a = __actors.manager.get(${step.uid}); if (a?.alive) __pt.aimAt(a.position.x, a.position.y + 1.5, a.position.z); return 1; })()`);
            await sleep(80);
            const r = await ev(`(() => { const a = __actors.manager.get(${step.uid}); if (!a?.alive) return 'gone'; __pt.aimAt(a.position.x, a.position.y + 1.5, a.position.z); return __pt.attack() ? 'hit' : ''; })()`);
            if (r === 'gone') break;
            await sleep(600);
          }
          if (!(await ev(step.until))) cur.problems.push(`shoot #${hex(step.uid)}: not done in ${step.timeout ?? 60} s`);
          break;
        }
        case 'clamber': {
          // Walk to the foot of the ledge, face it and press Space (the clamber key) for each
          // Clamber Point in turn. Creatures that hunt the player there are fought first, as a
          // player would (1b: Detectors 6727 / 76d6 wake CartWheelers 6725 / 6726 on the way, and
          // their blows knocked the player off the first ledge), then the foot is walked to again.
          // `here`: from where the player stands (8a: on top of the crate 193a, a spot the planner
          // cannot walk to).
          if (!step.here) {
            await walk(step.from, step.tol ?? 0.3, 40);
            if (await fight(40, false, true)) await walk(step.from, step.tol ?? 0.3, 40);
            // `preLoot` (m): what lies by the foot is picked up before the climb (1b: Xombium
            // bottles 700e / 700f by the ledges, after the ambush).
            if (step.preLoot) {
              await loot(step.preLoot);
              await walk(step.from, step.tol ?? 0.3, 40);
            }
          }
          for (const [i, f] of step.face.entries()) {
            // Where to stand on a ledge for the next one (a corner landing faces the wrong side).
            if (step.stands?.[i] && (i || step.nudge)) {
              // `nudge`: on a ledge too narrow for the planner (3b's 2bfd), a short tap of W
              // towards the stand instead of a planned walk (whose stuck jumps threw him off).
              if (step.nudge) {
                const sp = step.stands[i];
                const d = await ev(`(() => { const p = __player.position; __pt.aimAt(${sp[0]}, p.y + 1.6, ${sp[2]}); return Math.hypot(p.x - ${sp[0]}, p.z - ${sp[2]}); })()`);
                await keyEv('keyDown', 'KeyW');
                await sleep(Math.min(600, Math.max(60, d * 250)));
                await keyEv('keyUp', 'KeyW');
              } else await walkRaw(step.stands[i], 0.25, 8);
            }
            // `settle` (s): let the body come to rest on a narrow ledge first (3b's 2bfd).
            if (step.settle) await sleep(step.settle * 1000);
            // On the ground first: a walk can end in the air (a stuck jump against the rock face at
            // 4b's third ledge), and Space in the air neither clambers (walking only) nor jumps; the
            // feet read then were the jump's (4b.climb3: "feet 99.97 -> 99.11").
            const grounded = () => waitFor(() => ev('__player.onGround && Math.abs(__player.velocity?.y ?? 0) < 0.05'), 4000, 'on the ground').catch(() => false);
            await grounded();
            const y0 = (await ev('__pt.state()')).p[1];
            let y1 = y0;
            // A second try when nothing happened (3b's second ledge: once in four runs the press
            // came while the body was still sliding to rest at the foot).
            for (let attempt = 0; attempt < 3 && y1 - y0 < 0.5; attempt++) {
              if (attempt) {
                note(`clamber towards ${f.map((v) => v.toFixed(1))} did not start: again`);
                // A creature at the foot (1b's arena copies at the second ledge) turned the view
                // or knocked him: fight it first, then back to the stand.
                const fought = await fight(20, false, true);
                if (!i && !step.here) await walk(step.from, step.tol ?? 0.3, 20);
                else if (fought && step.stands?.[i]) await walkRaw(step.stands[i], 0.25, 8);
                await sleep(600);
              }
              // Grounded first, then the aim (the wait let the view be turned away: 1b's second
              // ledge was pressed facing +x).
              await grounded();
              await ev(`(() => { __pt.aimAt(${f[0]}, ${f[1]}, ${f[2]}); return 1; })()`);
              await sleep(300);
              await press('Space');
              await sleep(1400);
              y1 = (await ev('__pt.state()')).p[1];
            }
            if (y1 - y0 < 0.5) {
              // Where the press came from, for the record (stand, ground, facing).
              note(`clamber press from ${JSON.stringify(await ev('(() => { const p = __player.position; return { p: [p.x, p.y, p.z].map((v) => +v.toFixed(2)), ground: __player.onGround, yaw: +__player.yaw.toFixed(2) }; })()'))}`);
              cur.problems.push(`clamber towards ${f.map((v) => v.toFixed(1))} did not start (feet ${y0.toFixed(2)} -> ${y1.toFixed(2)})`);
            } else note(`clambered ${y0.toFixed(2)} -> ${y1.toFixed(2)}`);
          }
          break;
        }
        case 'route': {
          // A hand-laid line of points the grid planner does not take (drops of a few metres, a
          // jump up a mound): the autopilot steers along them, W held, Space when stuck.
          // `relTo` uid: pts and jumpAt are offsets (x, z) from that object's centre where it is now
          // (8a: the crate 193a, wherever the push left it).
          let rpts = step.pts, rjump = step.jumpAt;
          if (step.relTo) {
            const c = await ev(`__pt.center(${step.relTo})`);
            rpts = step.pts.map((q) => [c[0] + q[0], q[1], c[2] + q[2]]);
            rjump = step.jumpAt && [c[0] + step.jumpAt[0], c[2] + step.jumpAt[1], step.jumpAt[2]];
          }
          const pts = [await ev('__pt.state().p'), ...rpts];
          await ev(`(() => { __pt.go(${JSON.stringify(pts)}, 0.35); return 1; })()`);
          await keyEv('keyDown', 'KeyW');
          const tEnd = Date.now() + (step.timeout ?? 25) * 1000;
          let jumps = 0;
          // `jumpAt` [x, z, r] (or a list of them, taken in order): a running jump (Space, W
          // held) once within r m of x / z (3a's leap off the shack roof, 4b's pallet).
          const leaps = !rjump ? [] : Array.isArray(rjump[0]) ? rjump : [rjump];
          let leap = 0;
          while (Date.now() < tEnd) {
            await sleep(leap < leaps.length ? 25 : 120);
            const ap = await ev(`(() => { const a = __pt.ap; const p = __player.position; return { done: a.done, stuck: a.stuck, x: p.x, z: p.z }; })()`);
            if (leap < leaps.length && Math.hypot(ap.x - leaps[leap][0], ap.z - leaps[leap][1]) <= leaps[leap][2]) {
              leap++;
              await press('Space');
              note(`jumped at ${ap.x.toFixed(2)}, ${ap.z.toFixed(2)}`);
              continue;
            }
            if (ap.done) break;
            if (ap.stuck >= 1 && jumps < 6) {
              jumps++;
              await press('Space');
              await ev(`(() => { __pt.ap.stuck = 0; return 1; })()`);
            }
          }
          await keyEv('keyUp', 'KeyW');
          await ev(`(() => { __pt.ap.active = false; return 1; })()`);
          const end = rpts[rpts.length - 1];
          await waitFor(() => ev('__player.onGround'), 3000, 'landing').catch(() => {});
          const st = await ev('__pt.state()');
          const d = Math.hypot(st.p[0] - end[0], st.p[2] - end[2]);
          if (d > 1.5 || Math.abs(st.p[1] - end[1]) > 1.2) cur.problems.push(`route: ended ${d.toFixed(1)} m from its last point`);
          if (jumps) note(`${jumps} jump(s) on the way`);
          break;
        }
        case 'evade': {
          // (Prelude route) Keep away from what attacks without fighting back: run round a loop of
          // points (`pts`), W held, the next lap starting where the last ended, until `until`
          // holds (the Prelude's guards beat the handcuffed Torque until the scripted
          // transformation). Health and the attackers' distance are logged.
          const end = Date.now() + (step.timeout ?? 40) * 1000;
          let laps = 0;
          let legAt = 0;
          let minHp = await ev('__actors.combat.health');
          await keyEv('keyDown', 'KeyW');
          try {
            while (Date.now() < end && !abortRun && !(await ev(step.until))) {
              await checkDeath();
              const ap = await ev(`(() => { const a = __pt.ap; return { done: !a.active || a.done, stuck: a.stuck }; })()`);
              // A leg ends at its point, when blocked (an attacker in the way) or after 3 s.
              if (ap.done || ap.stuck >= 1 || Date.now() - legAt > 3000) {
                legAt = Date.now();
                // Next lap from the point nearest ahead of the player.
                const pts = await ev(`(() => { const p = __player.position, L = ${JSON.stringify(step.pts)}; let k = 0, bd = 1e9; L.forEach((q, i) => { const d = Math.hypot(q[0] - p.x, q[2] - p.z); if (d < bd) (bd = d), (k = i); }); return [...L.slice(k + 1), ...L.slice(0, k + 1)]; })()`);
                await ev(`(() => { __pt.go(${JSON.stringify(pts)}, 0.6); return 1; })()`);
                laps++;
              }
              minHp = Math.min(minHp, await ev('__actors.combat.health'));
              await sleep(120);
            }
          } finally {
            await keyEv('keyUp', 'KeyW');
            await ev(`(() => { __pt.ap.active = false; return 1; })()`);
          }
          note(`evaded ${laps} leg(s), health down to ${Math.round(minHp)}`);
          if (!(await ev(step.until))) cur.problems.push(`evade: ${step.until} not reached in ${step.timeout ?? 40} s`);
          break;
        }
        case 'throw': {
          // Throw the selected throwable at a character until `until` holds (5b: the Killjoy
          // Rebirth grenade 4:804 at the insanity creature). Throw is the right mouse button,
          // which needs pointer lock: services.weapons.throw (logged).
          shortcut('api', 'Throw through services.weapons.throw (the right mouse button needs pointer lock)');
          const end = Date.now() + (step.timeout ?? 60) * 1000;
          if (step.from) await walk(step.from, 0.4, 60);
          // `select`: the throwable to use (8b: the Molotov 4:249); `near` [x, y, z, r]: the target
          // is whichever `cls` character (cloned copies have no level uid) stands within r of that
          // spot, waited for until one does (8b: a Hermes copy at the stove).
          if (step.select) await ev(`(() => { __weapons.service.selectThrowable(${JSON.stringify(step.select)}); return 1; })()`);
          const pick = step.near
            ? `(() => { const [x, , z, r] = ${JSON.stringify(step.near)}; let b = null, bd = r; for (const a of __actors.manager.actors) { if (!a.alive || a.hidden || (${JSON.stringify(step.cls ?? '')} && a.entity?.className !== ${JSON.stringify(step.cls ?? '')})) continue; const d = Math.hypot(a.position.x - x, a.position.z - z); if (d <= bd) (bd = d), (b = a); } return b; })()`
            : `__actors.manager.get(${step.uid})`;
          let throws = 0;
          while (Date.now() < end && !(await ev(step.until))) {
            await checkDeath();
            if (await cinematic()) {
              await waitCine();
              continue;
            }
            // `ready`: a further condition to throw on (8b: Relay 1f0d enabled, the copy in Detector 2565).
            if (!(await ev(`!!${pick}`)) || (step.ready && !(await ev(step.ready)))) {
              await sleep(250);
              continue;
            }
            await ev(`(() => { __pt.ap.follow = 0; __pt.ap.active = false; const a = ${pick}; if (a) __pt.aimAt(a.position.x, a.position.y + 1.2, a.position.z); return 1; })()`);
            await sleep(150);
            const ok = await ev(`(() => { const a = ${pick}; if (a) __pt.aimAt(a.position.x, a.position.y + ${step.aimY ?? 1.2}, a.position.z); return __weapons.service.throw(); })()`);
            if (ok) {
              throws++;
              note(`threw ${await ev(`JSON.stringify(__weapons.service.throwable?.id ?? null)`)} at ${step.near ? `the ${step.cls ?? 'character'} by ${step.near.slice(0, 3).join(', ')}` : `#${hex(step.uid)}`}`);
            }
            await sleep(2500);
            if (step.max && throws >= step.max) break;
          }
          if (!(await ev(step.until))) cur.problems.push(`throw at ${step.near ? 'the target' : `#${hex(step.uid)}`}: not done in ${step.timeout ?? 60} s`);
          break;
        }
        case 'leap': {
          // A running jump (5b: out of the theatre window): from `from`, the view turned towards
          // `to`, W held; Space after `after` s of run-up; W kept `hold` s more.
          for (let n = 0; n < 2 && !(await walk(step.from, 0.3, 60)).arrived; n++);
          await ev(`(() => { __pt.ap.follow = 0; __pt.ap.active = false; const p = __player.position; __pt.aimAt(${step.to[0]}, p.y + 1.6, ${step.to[2]}); return 1; })()`);
          await sleep(300);
          await keyEv('keyDown', 'KeyW');
          await sleep((step.after ?? 0.3) * 1000);
          await press('Space');
          await sleep((step.hold ?? 1.5) * 1000);
          await keyEv('keyUp', 'KeyW');
          break;
        }
        case 'ladder': {
          // Walk to the foot of the ladder, face it and hold W: walking into it attaches, W climbs,
          // the top lets go onto the landing.
          // `run: true`: no stopping to fight on the way (a swarm at the foot: r1b's sewer rats).
          for (let n = 0; n < 2 && !(await walk(step.from, 0.4, 90, { noFight: !!step.run })).arrived; n++);
          await ev(`(() => { __pt.aimAt(${step.face[0]}, ${step.face[1]}, ${step.face[2]}); return 1; })()`);
          await keyEv('keyDown', 'KeyW');
          // Not attached by walking into it after 2 s: Use (E) at it, as a player would.
          if (!(await waitFor(() => ev('!!__world.interact.climb'), 2000, 'ladder attach').catch(() => false))) {
            note('ladder: walking into it did not attach: E');
            await press('KeyE');
          }
          const up = await waitFor(() => ev(`__player.position.y >= ${step.top} && !__world.interact.climb`), 15_000, 'ladder top').catch(() => false);
          await keyEv('keyUp', 'KeyW');
          if (!up) cur.problems.push(`ladder: not at the top (y ${(await ev('__pt.state()')).p[1].toFixed(2)})`);
          break;
        }
        case 'ladderDown': {
          // From the top (3a's manhole ladder 157b): look at the ladder, E attaches at its top, S
          // climbs down to the foot.
          // Up to three tries: the walk can end a few centimetres off the stand with the view then
          // missing the ladder (3a's manhole 157b: "the view targets nothing" in two runs of four).
          for (let attempt = 0; attempt < 3 && !(await ev(`!!__world.interact.climb`)); attempt++) {
            for (let n = 0; n < 2 && !(await walk(step.from, 0.3, 90)).arrived; n++);
            await ev(`(() => { __pt.aimAt(${step.face.join(',')}); return 1; })()`);
            await sleep(400);
            const t = await ev(`__world.pickTarget()?.w?.uid ?? 0`);
            if (t !== step.uid) note(`ladder #${hex(step.uid)}: the view targets ${t ? '#' + hex(t) : 'nothing'}`);
            await press('KeyE');
            await sleep(500);
          }
          if (!(await ev(`!!__world.interact.climb`))) cur.problems.push('ladder: E did not attach at the top');
          await keyEv('keyDown', 'KeyS');
          // S is let go the moment the climb ends: held on, it walks the player backwards off the
          // landing (9's lamp room ladder 9da lands beside the stairwell).
          await waitFor(() => ev(`!__world.interact.climb`), 20_000, 'ladder foot').catch(() => false);
          await keyEv('keyUp', 'KeyS');
          const down = await waitFor(() => ev(`__player.position.y <= ${step.bottom}`), 2000, 'ladder foot').catch(() => false);
          // Turn away from the ladder: the next walk would otherwise start into it and mount it again.
          await ev(`(() => { const p = __player.position; __pt.aimAt(2 * p.x - ${step.face[0]}, p.y + 1.6, 2 * p.z - ${step.face[2]}); return 1; })()`);
          if (!down) cur.problems.push(`ladder: not at the foot (y ${(await ev('__pt.state()')).p[1].toFixed(2)})`);
          break;
        }
        case 'searchlight': {
          // A searchlight Mountable (src/game/world/searchlight.ts): E at it mounts it, Fire (the left
          // mouse button) lights it, the view aims the beam at `at` until `until` holds, E leaves.
          for (let n = 0; n < 2 && !(await walk(step.from, 0.3, 60)).arrived; n++);
          await ev(`(() => { const c = __pt.center(${step.uid}); __pt.aimAt(c[0], c[1] + 0.3, c[2]); return 1; })()`);
          await sleep(400);
          await press('KeyE');
          const mounted = await waitFor(() => ev(`__world.interact.mounted?.w.uid === ${step.uid}`), 3000, 'mounted').catch(() => false);
          if (!mounted) {
            cur.problems.push(`searchlight #${hex(step.uid)}: not mounted (view targets ${hex(await ev(`__world.pickTarget()?.w?.uid ?? 0`))})`);
            break;
          }
          if (!(await ev(`!!__world.searchlights()?.isOn(${step.uid})`))) {
            // A click on the canvas asks for pointer lock, which headless refuses with an exception.
            shortcut('api', 'Fire on the mounted searchlight as a window mousedown (a canvas click asks for pointer lock)');
            await ev(`(() => { for (const type of ['mousedown', 'mouseup']) window.dispatchEvent(new MouseEvent(type, { button: 0 })); return 1; })()`);
          }
          note(`searchlight #${hex(step.uid)} lit: ${await ev(`!!__world.searchlights()?.isOn(${step.uid})`)}`);
          await ev(`(() => { __pt.aimAt(${step.at.join(',')}); return 1; })()`);
          if (!(await waitFor(() => ev(step.until), 10_000, 'beam on the target').catch(() => false))) cur.problems.push(`searchlight #${hex(step.uid)}: ${step.until} not met`);
          await sleep(500);
          await shot(`${step.id}-beam`);
          await press('KeyE');
          await sleep(500);
          break;
        }
        case 'crane': {
          // Crane controls (a Mountable whose p30 names a Crane: src/game/levels/crane.ts): E at
          // them mounts, the look input swings the crane (horizontal) and raises / lowers the hook
          // (vertical). The view is turned by a steady rate per frame (`look`: [yaw, pitch] rad per
          // frame, as a mouse held moving) for each phase until its `until` holds or `max` s pass;
          // E leaves.
          for (let n = 0; n < 2 && !(await walk(step.from, 0.3, 60)).arrived; n++);
          await ev(`(() => { const c = __pt.center(${step.uid}); __pt.aimAt(c[0], c[1] + 0.3, c[2]); return 1; })()`);
          await sleep(400);
          await press('KeyE');
          if (!(await waitFor(() => ev(`__world.interact.mounted?.w.uid === ${step.uid}`), 3000, 'mounted').catch(() => false))) {
            cur.problems.push(`crane controls #${hex(step.uid)}: not mounted (view targets ${hex(await ev(`__world.pickTarget()?.w?.uid ?? 0`))})`);
            break;
          }
          shortcut('api', 'the look input as a per-frame view turn (the mouse needs pointer lock)');
          await ev(`(() => { if (!window.__ptLook) { window.__ptLook = { yaw: 0, pitch: 0 }; __view.onFrame(() => { const l = window.__ptLook; if (l.yaw) __player.yaw += l.yaw; if (l.pitch) __player.pitch += l.pitch; }); } return 1; })()`);
          for (const ph of step.phases) {
            await ev(`(() => { window.__ptLook.yaw = ${ph.look[0]}; window.__ptLook.pitch = ${ph.look[1]}; return 1; })()`);
            const ok = ph.until ? await waitFor(() => ev(ph.until), (ph.max ?? 10) * 1000, 'crane phase').catch(() => false) : (await sleep((ph.max ?? 1) * 1000), true);
            await ev(`(() => { window.__ptLook.yaw = 0; window.__ptLook.pitch = 0; return 1; })()`);
            if (!ok) cur.problems.push(`crane phase ${JSON.stringify(ph.look)}: ${ph.until} not met in ${ph.max ?? 10} s`);
          }
          note(`crane: ${JSON.stringify(await ev(`(() => { const c = __levels.skinnedProps.cranes.get(__world.interact.mounted?.crane); return c && { slew: +c.slew.toFixed(3), cable: +c.hoist.cable.toFixed(2) }; })()`))}`);
          await shot(`${step.id}-crane`);
          await press('KeyE');
          await sleep(500);
          break;
        }
        case 'boss': {
          let lootedForBoss = false;
          // 10's Black Ones (specials/black-one.ts): one is up at a time and only its heart takes
          // hits: aim at the one up (`uids`, the special's `holder`) and shoot (Fire through
          // services.weapons.fire, logged like every shot of the run), drinking Xombium when low.
          const end = Date.now() + (step.timeout ?? 300) * 1000;
          let shots = 0;
          while (Date.now() < end && !abortRun && !(await ev(step.until))) {
            await checkDeath();
            if (await cinematic()) {
              await waitCine();
              continue;
            }
            if (await ev(`__actors.combat.health < 40 && (__hud.model().healthPacks ?? 0) > 0 && __weapons.service.useHealthPack()`)) shortcut('api', 'Xombium bottle through useHealthPack (the H key needs pointer lock)');
            if (await outOfSea(step)) continue;
            // The heart is out of the shiv's reach: out of rounds, the dock's ammo boxes (six
            // by the crates at 478.5, 268.5) as a player would take them.
            if (!lootedForBoss && !(await ev(`__weapons.service.weapons.some((x) => x.kind === 'ranged' && x.clip + x.reserve > 0)`))) {
              lootedForBoss = true;
              note('out of rounds: to the ammo boxes on the dock');
              // (Some stand on crates: no planner path onto them, so walk up to each and take it.)
              const boxes = await ev(`(() => { const p = __player.position; return __world.world.of('Ammo Box').filter((e) => !e.destroyed && !e.s.taken && e.visible && Math.hypot(e.pos[0] - p.x, e.pos[2] - p.z) < ${step.lootRadius ?? 35} && Math.abs(e.pos[1] - p.y) < 2).map((e) => e.uid); })()`);
              let took = 0;
              for (const u of boxes) if (await pick(u)) took++;
              note(`took ${took} of ${boxes.length} ammo boxes`);
              continue;
            }
            const up = await ev(`(() => { const h = ${JSON.stringify(step.uids)}.find((u) => { const i = __specials.get(u)?.info; return !!i && i.holder && i.bo !== 'hidden' && !i.done; }); if (!h) return 0; const c = __pt.center(h); __pt.ap.follow = 0; __pt.ap.active = false; __pt.aimAt(c[0], c[1], c[2]); return h; })()`);
            if (!up) {
              await sleep(250);
              continue;
            }
            // (Aim, let a frame draw it, then fire: see `break`.)
            await sleep(80);
            if (await ev(`(() => { const c = __pt.center(${up}); __pt.aimAt(c[0], c[1], c[2]); return __pt.attack(); })()`)) shots++;
            await sleep(120);
          }
          note(`boss: ${shots} shots, ${JSON.stringify(await ev(`${JSON.stringify(step.uids)}.map((u) => { const i = __specials.get(u)?.info; return i && [u.toString(16), i.stage, i.heart, i.hits, i.done]; })`))}`);
          if (!(await ev(step.until))) cur.problems.push(`boss: not beaten in ${step.timeout ?? 300} s`);
          break;
        }
        case 'finish': {
          // The Game Finished screen (GUI Launcher mode 6 -> the menu flow's openGameFinished):
          // Save Settings with the arrow keys and Enter, then the credits roll (docs/campaign.md §5.3).
          if (!(await ev(`!!window.__menu`))) {
            note('no menus (started through the deep link): Game Finished and the credits are the front end\'s');
            if (!(await ev(`!!window.__campaign?.state?.ending`))) cur.problems.push('no ending recorded');
            break;
          }
          const stackIds = `__menu.frontend.stack.map((t) => t.screen.id)`;
          if (!(await waitFor(() => ev(`${stackIds}.includes('gameFinished')`), (step.timeout ?? 120) * 1000, 'Game Finished').catch(() => false))) {
            cur.problems.push(`no Game Finished screen (${JSON.stringify(await ev(stackIds).catch(() => null))})`);
            break;
          }
          await sleep(1500);
          await shot(`${step.id}-game-finished`);
          await menuChoose(`it.action?.kind === 'gameFinished' && it.action.save`);
          if (!(await waitFor(() => ev(`${stackIds}.includes('credits')`), 20_000, 'credits').catch(() => false))) {
            cur.problems.push(`no credits after Game Finished (${JSON.stringify(await ev(stackIds).catch(() => null))})`);
            break;
          }
          const ending = await ev(`window.__campaign?.state?.ending ?? null`);
          note(`ending ${ending}: Game Finished, then the credits`);
          // `endings`: per ending, the objects its chain must reach (10: the Movie Player, the boat
          // sequence, the picture's GUI Launcher) and none of the other endings' (the page's
          // message log: messages sent to them while the level ran). `bonus`: reached only on
          // Impossible (the bonus movie 13b2).
          if (step.endings) {
            const to = new Set(await ev(`(window.__pt?.seen ?? []).map((x) => x[3])`).catch(() => []));
            const from = new Set(await ev(`(window.__pt?.seen ?? []).map((x) => x[2])`).catch(() => []));
            const got = (uids) => uids.filter((u) => to.has(hex(u)));
            for (const [name, uids] of Object.entries(step.endings)) {
              const g = got(uids);
              note(`${name}: ${uids.map((u) => `#${hex(u)} ${g.includes(u) ? 'reached' : '-'}`).join(', ')}`);
              if (name === ending && g.length !== uids.length) cur.problems.push(`${name} ending: not reached ${uids.filter((u) => !g.includes(u)).map(hex).join(', ')}`);
              if (name !== ending && g.length) cur.problems.push(`${name} ending objects reached in the ${ending} ending: ${g.map(hex).join(', ')}`);
            }
            if (step.bonus) {
              // The difficulty the game finished on (a --save restore plays the capture's own).
              const diff = logs.filter((l) => /game finished: reputation/.test(l)).at(-1)?.match(/\((\w+)\)/)?.[1] ?? DIFFICULTY_NAMES[DIFFICULTY];
              // Played: its end output went out (a message from it). Below Impossible the movie is
              // not placed at all (instance flags 0x70001, docs/campaign.md §6): Timer 1241's On
              // to it goes nowhere.
              const b = step.bonus.some((u) => from.has(hex(u)));
              note(`bonus movie ${step.bonus.map(hex).join(', ')}: ${b ? 'played' : 'not played'}${got(step.bonus).length ? ' (sent On)' : ''} (difficulty ${diff})`);
              if (b !== (diff === 'Impossible')) cur.problems.push(`bonus movie ${b ? 'played' : 'not played'} on ${diff}`);
            }
          }
          if (opt('--expect-ending') && ending !== opt('--expect-ending')) cur.problems.push(`ending ${ending}, expected ${opt('--expect-ending')}`);
          for (let n = 0; n < 4; n++) {
            await sleep(5000);
            await shot(`${step.id}-credits-${n + 1}`);
          }
          break;
        }
        case 'follow':
          if (!(await follow(step.uid, step.until, step.timeout, { fight: !!step.fight }))) cur.problems.push(`#${hex(step.uid)} did not get there in ${step.timeout} s`);
          break;
        case 'saveLoad': {
          const r = await saveLoad(step.label);
          if (!r.ok) cur.problems.push(`save/load: ${r.error ?? r.diff?.join(' | ')}`);
          break;
        }
        case 'teleport':
          shortcut('teleport', step.why);
          await ev(`(() => { __player.teleport({ x: ${step.to[0]}, y: ${step.to[1]}, z: ${step.to[2]} }); return 1; })()`);
          await sleep(500);
          break;
      }
      const then = step.then ?? {};
      if (then.until) await waitAlive(then.until, then.timeout ?? 60, step.id);
      if (then.level) {
        const arrived = async () => stem(await levelNow()) === then.level && (await ev(`!!window.__world?.world && __world.world.time > 1 && !!window.__actors?.combat`).catch(() => false));
        if (!(await waitFor(arrived, 30_000, `level ${then.level}`).catch(() => false)) && step.transition) {
          cur.problems.push(`no level transition 30 s after using the exit`);
          shortcut('transition', `Level Transition #${hex(step.transition)} fired through the campaign service (still disabled by the level logic)`);
          await ev(`__campaign.service.fireTransition(${step.transition}, true)`);
        }
        // (A loaded machine took over 210 s to bring 1b up from 6b's exit: the chapter screen
        // stood over 6b the whole time. The deep link allows 600 s for a first level.)
        await waitFor(arrived, 420_000, `level ${then.level}`).catch((e) => cur.problems.push(e.message));
        await ensurePage();
        note(`arrived in ${then.level} at ${(await ev('__pt.state()')).p.map((v) => v.toFixed(1))}`);
      }
      if (then.cine && !cur.cineSeen) {
        // Wait for the cinematic (up to 8 s), but do not stand still under attack meanwhile.
        const seen = await waitFor(async () => (await cinematic()) || ((await ev(`(() => { const t = __pt.engage(7); __pt.ap.follow = 0; return !!t && ['chase', 'attack', 'shoot', 'hurt'].includes(t.st); })()`)) && 'threat'), 8000, 'cinematic').catch(() => false);
        if (seen === true) await waitCine();
        else note(seen === 'threat' ? 'attacked before any cinematic' : 'no cinematic started');
      }
      if (then.wait) await sleep(then.wait * 1000);
      if (then.fight) await fight(then.fight, false, false, then.stay ?? null);
      if (step.loot) await loot(step.loot);
      // `noCineWait`: a cinematic the step ends in is left to the next step (the Prelude's exit
      // ends in 1a's opening, which the next step watches and skips like 1a.intro).
      if (!step.noCineWait) await waitCine();
      let missed = await checkExpect(step.expect, cpBefore);
      // A trigger plane crossed while the player was busy (a fight, a vision) can be missed by the
      // run: walk back over it and on again once (logged).
      if (missed.length && step.again) {
        note(`expectation missed (${missed.join(' | ')}): back to ${step.again.map((v) => v.toFixed(1))} and on again`);
        await walk(step.again, 0.6, 30);
        await walk(step.to, 0.6, 30);
        await sleep(1500);
        await waitCine();
        missed = await checkExpect(step.expect, cpBefore);
      }
      cur.problems.push(...missed);
      if (cur.problems.length && step.diag) cur.problems.push(`why: ${await ev(step.diag).catch((e) => e.message)}`);
      const trace = await ev(`(window.__ptTrace ?? []).splice(0).slice(-80)`).catch(() => []);
      if (trace?.length) note(`trace: ${trace.join('; ')}`);
    } catch (e) {
      if (e instanceof Died) {
        deaths++;
        cur.problems.push('player died');
        // Counted here: the retry returns before the probes below set `ok`.
        cur.ok = false;
        failures++;
        cur.ms = Date.now() - ts;
        // Back to the last step that produced a checkpoint and retry once with god mode (logged).
        let back = report.steps.length > 1 ? ROUTE.findLastIndex((s, k) => k < i && s.expect?.checkpoint) : -1;
        // The checkpoint the game restores is the last Autosave taken: the step that expects it
        // (this very step when it took it before the death: the step is played again).
        const lastCp = logs.filter((l) => /\[save\] checkpoint \(Autosave #/.test(l)).at(-1)?.match(/#([0-9a-f]+)/)?.[1];
        const k = lastCp ? ROUTE.findLastIndex((s, n) => n <= i && s.expect?.checkpoint === parseInt(lastCp, 16)) : -1;
        if (k >= 0 && report.steps.length > 1) back = k === i ? i - 1 : k;
        // A checkpoint taken during this step that no step names: this step again from it.
        else if (stepCpBefore >= 0 && checkpointsTaken() > stepCpBefore) back = i - 1;
        // Never back into an earlier level's steps: without a checkpoint of this level the game
        // restores its start (9 -> 10: a death before 10's first Autosave went back to 9.east).
        const lvlOf = (k) => ROUTE[k]?.id.split('.')[0];
        if (back >= 0 && lvlOf(back + 1) !== lvlOf(i)) back = ROUTE.findIndex((s) => s.id.split('.')[0] === lvlOf(i)) - 1;
        if (deaths <= 3) {
          shortcut('invulnerable', `retry after death #${deaths} from the checkpoint (kept on from here)`);
          godMode = true;
          await ensurePage();
          return Math.max(back, start - 1);
        }
      } else cur.problems.push(`error: ${e.message.split('\n')[0]}`);
    }
    // Probes.
    try {
      if (await inEndScreens()) throw Object.assign(new Error('end screens'), { endScreens: true });
      await ensurePage();
      await sleep(1000);
      const [st, m, san] = await Promise.all([ev(`__pt.state()`), ev(`__pt.metrics()`), ev(`__pt.sanity()`)]);
      Object.assign(cur, { hp: st.hp, alive: st.alive, pos: st.p, level: stem(await levelNow()), fps: m.fps, draws: m.draws, tris: m.tris, audio: m.audio, buses: m.buses, emitters: m.emitters, ambience: m.ambience, music: m.music, checkpoints: checkpointsTaken() });
      if (!st.alive) cur.problems.push('player dead');
      if (m.audio && m.audio !== 'running') cur.problems.push(`audio context ${m.audio}`);
      if (!m.ambience) cur.notes.push(`no ambience source active${m.ambienceZone ? ` (zone ${m.ambienceZone})` : ''}`);
      for (const k of ['floating', 'sinking', 'stuck']) if (san[k].length) cur.problems.push(`${k} actors: ${san[k].slice(0, 4).join('; ')}`);
      const lvl = cur.level;
      (report.perf[lvl] ??= []).push({ step: step.id, fps: m.fps, draws: m.draws, tris: m.tris });
    } catch (e) {
      if (e.endScreens) cur.notes.push('Game Finished / credits on screen: no level probes');
      else cur.problems.push(`probe error: ${e.message.split('\n')[0]}`);
    }
    const newProblems = problems.filter((p) => !/^warn: \[(renderer|fx|world|actors|levels)\]/.test(p));
    if (newProblems.length) cur.problems.push(...newProblems.slice(0, 6));
    if (step.shot || cur.problems.length) cur.shot = await shot(`${String(i).padStart(2, '0')}-${step.id}`);
    cur.ms = Date.now() - ts;
    cur.ok = cur.problems.length === 0;
    if (!cur.ok) failures++;
    console.log(`     ${cur.ok ? 'ok' : 'PROBLEMS: ' + cur.problems.join(' | ')} - hp ${cur.hp} at ${cur.pos?.map((v) => v.toFixed(1))} fps ${cur.fps} draws ${cur.draws} music ${cur.music?.playing ? cur.music.current : '-'} (${(cur.ms / 1000).toFixed(1)} s)`);
    report.logs.push(...logs.slice(lastLogN).filter((l) => /\[save\]|\[campaign\]|\[sequence\] cinematic|EXC|^error/.test(l)));
    lastLogN = logs.length;
    return i;
  }
  report.deaths = deaths;
  report.seconds = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${report.steps.filter((s) => s.ok).length}/${report.steps.length} steps ok, ${deaths} death(s), ${report.seconds} s`);
  for (const [lvl, rows] of Object.entries(report.perf)) {
    const f = rows.map((r) => r.fps);
    const d = rows.map((r) => r.draws);
    console.log(`  perf ${lvl}: fps min ${Math.min(...f)} avg ${(f.reduce((a, b) => a + b, 0) / f.length).toFixed(0)}, draws max ${Math.max(...d)}`);
  }
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 1));

  if (keep) {
    // Control server for exploring by hand (see the header).
    ctl = httpServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      let body = '';
      for await (const c of req) body += c;
      try {
        let out;
        if (u.pathname === '/eval') {
          const r = await send('Runtime.evaluate', { expression: body, returnByValue: true, awaitPromise: true });
          out = r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text } : r.result?.result?.value;
        } else if (u.pathname === '/key') {
          const k = JSON.parse(body);
          out = await send('Input.dispatchKeyEvent', { type: k.type, code: k.code, key: k.key ?? k.code, windowsVirtualKeyCode: k.vk ?? VK[k.code] ?? 0 });
        } else if (u.pathname === '/shot') out = await shot(u.searchParams.get('name') ?? 'shot', u.searchParams.has('png'));
        else if (u.pathname === '/logs') out = { n: logs.length, logs: logs.slice(Number(u.searchParams.get('since') ?? 0)) };
        else if (u.pathname === '/inject') out = await ensurePage();
        else if (u.pathname === '/abort') out = abortRun = true;
        else if (u.pathname === '/step') out = await stepHook?.(u.searchParams.get('id'));
        else if (u.pathname === '/capture') {
          // The running level's state as a save (JSON), for --save.
          const f = join(TMP, `${u.searchParams.get('name') ?? 'capture'}.json`);
          writeFileSync(f, JSON.stringify(await ev(`__saves.capture('manual', 'capture')`)));
          out = f;
        } else if (u.pathname === '/run') {
          // POST a step object (JSON, as in ROUTE) to try it before it goes into the route.
          const s = JSON.parse(body);
          ROUTE.push(s);
          out = await stepHook?.(s.id);
        }
        else if (u.pathname === '/quit') {
          res.end('bye');
          process.exit(failures ? 1 : 0);
        }
        res.end(JSON.stringify(out ?? null));
      } catch (e) {
        res.end(JSON.stringify({ error: String(e) }));
      }
    }).listen(ctlPort, '127.0.0.1');
    console.log(`control server on 127.0.0.1:${ctlPort} (GET /quit to stop)`);
    await new Promise(() => {});
  }
} catch (e) {
  console.error(e);
  const errs = (globalThis.__ptLogs ?? []).filter((l) => /^(error|warn|EXC)/i.test(l)).slice(-12);
  if (errs.length) console.error(`last page errors / warnings:\n  ${errs.map((l) => l.slice(0, 400)).join('\n  ')}`);
  failures++;
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 1));
} finally {
  if (!keep) cleanup();
}
process.exit(failures ? 1 : 0);
