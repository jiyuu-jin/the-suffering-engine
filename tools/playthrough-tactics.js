// Fight tactics for the playthrough harness (tools/playthrough.mjs): what a competent player
// does in a gunfight or before a known ambush, with the inputs a player has. No game rule is
// touched and nothing a player could not do is done: the moves are the real keys (W / S / A / D),
// and the inputs that need pointer lock in headless Chrome go through the same
// calls as the rest of the harness (Fire through services.weapons.fire, Reload through services.weapons.reload, the Xombium bottle
// through useHealthPack, a throw through services.weapons.throw, the transformation through
// __insanity.transform), each logged as a shortcut. No cheat, no invulnerability, no teleport.
//
// What the tactics read is what a player sees: where the enemies stand, which way they face,
// whether a gunman has raised his guns (his aim pose / firing clip), the HUD's health, bottles,
// rounds, throwables and insanity meter. The rules they lean on are the decoded ones
// (docs/game-logic.md):
// - NPC bullets are hitscan and need a clear line at the clip's Fire marker; a body out of every
//   line takes nothing (cover).
// - The ranged Slayer (class Slayer, 10:527) fires five rounds of 3 a clip, two clips an Attack;
//   its kick (MeleeAttack 10:1566) deals no damage (no Arm marker, no Melee Weapon), and it picks
//   the kick, not a volley, when the player is in its kick reach. A gunman whose every melee
//   attack is such a weapon-less one is harmless hand to hand: the player closes in and shoots
//   it from there ("crowd the gunman").
// - A CartWheeler's blades sweep its front: with a gun the player backs off out of the sweep
//   with a sidestep and shoots (the fight loop's kite did it only once it struck within 3 m).
//
// Page side: `pageTactics` is injected after tools/playthrough-page.js (it reads `__pt`) and puts
// its helpers on `__pt.tac`.

// ---- Decisions (pure; tests/playthrough-tactics.test.ts) --------------------------------------

/**
 * A gunman whose melee does no harm (an actor: `profile`, `kind`): a ranged profile that is not
 * thrown, no Melee Weapon held (`profile.melee`), and every melee attack of its kind a
 * weapon-only one (the blow comes only from an armed Melee Weapon). A kind with no melee attack
 * at all is left out: what it does up close is not known.
 */
export function harmlessUpClose(a) {
  return !!a?.profile?.ranged && !a.profile.ranged.thrown && !(a.profile.melee?.length) && (a.kind?.attacks?.length ?? 0) > 0 && a.kind.attacks.every((k) => k.weaponOnly);
}

/** Drink now: below 40, or below 55 with a gunman on the player (an Attack can take 30). */
export function drinkNow({ hp, packs, human, underFire }) {
  return human && packs > 0 && (hp < 40 || (underFire && hp < 55));
}

/**
 * Bottles to drink before a known fight: up to `want` health, keeping `keep` bottles, none on a
 * bar within `heal` of full (a bottle heals about 20 on Medium at reputation 0).
 */
export function braceDrinks({ hp, max, packs }, { hp: want = 85, keep = 1 } = {}, heal = 20) {
  let n = 0;
  while (hp < want && packs - n > keep && hp <= max - heal) (hp += heal), n++;
  return n;
}

/**
 * Back off from a blade: `me` (scene() row) a creature without a gun, chasing or striking within
 * 4 m, while the player is human with a gun on it. Not a Burrower (up only while it strikes) or
 * an Inferna (the fight loop has its own kite for its flames).
 */
export function keepFromBlade(me, { human, shoot }) {
  return !!me && human && shoot && !me.ranged && me.d < 4 && (me.st === 'chase' || me.st === 'attack') && me.cls !== 'Burrower' && me.cls !== 'Inferna';
}

/**
 * Breakable templates that blow up when broken: their break spawn (Breakable p18, an Object
 * Generator) makes Radius Damages (tests/playthrough-tactics.test.ts reads the chain): 1's gas
 * cans 7:2239 / 7:2240 / 7:2244 (15 -> 5 over 13 m, and 4:1042's 4:215, 40 -> 10 over 13 m)
 * and 7:2242 (20 -> 10, and the same 4:215). Set off together, four took 202 from a player
 * beside them (1b's hall door, run x2). Other levels' explosives are not listed yet.
 */
export const EXPLOSIVE_TEMPLATES = ['7:2239', '7:2240', '7:2242', '7:2244'];

/**
 * Transform now (meter full, checked by the caller): `sc` the scene() rows hunting the player,
 * `hp` his health.
 */
export function morphNow({ sc, hp }) {
  const close = sc.filter((x) => x.d < 4).length;
  return sc.some((x) => x.ranged && x.onMe && x.hp > 40) || sc.length >= 3 || (sc.length >= 2 && close >= 1) || (hp < 60 && close >= 1);
}

/* global window, __pt, __player, __actors, __weapons, __insanity, __hud, __view */
function pageTactics(harmlessUpClose, EXPLOSIVE) {
  if (!window.__pt) return false;
  const P = () => __player.position;
  const actor = (id) => __actors.manager.actors.find((x) => x.id === id);
  const human = () => (window.__insanity?.model?.form ?? 'human') === 'human';
  // Its guns up: the aim pose or the firing clip of a ranged attack (what a player sees).
  const gunsUp = (a) => a?.state === 'shoot';
  function gun() {
    const wp = window.__weapons;
    if (!wp) return null;
    const list = wp.service.weapons.filter((x) => x.kind === 'ranged');
    const cur = list.find((x) => x.id === wp.persist.current) ?? null;
    return { cur: cur ? { id: cur.id, clip: cur.clip, size: cur.clipSize, reserve: cur.reserve } : null, guns: list.map((x) => ({ id: x.id, clip: x.clip, size: x.clipSize, reserve: x.reserve })), busy: !!wp.service.busy };
  }
  // The fight as the player sees it: hostiles hunting him within `range` m.
  function scene(range = 25) {
    const p = P();
    const out = [];
    for (const a of __actors.manager.actors) {
      if (a.template || !a.alive || a.health <= 0 || !a.ch.root.visible || a.dormantHidden || !a.hostile) continue;
      if (__pt.isCompanion(a)) continue;
      const q = a.motor.position;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d > range || Math.abs(q.y - p.y) > 4) continue;
      if (!['chase', 'attack', 'shoot', 'hurt'].includes(a.state)) continue;
      out.push({ id: a.id, uid: a.entity?.uid ?? 0, cls: a.entity?.className ?? '', d: +d.toFixed(2), hp: +a.health.toFixed(1), st: a.state, ranged: !!a.profile?.ranged, crowd: harmlessUpClose(a), up: gunsUp(a), onMe: !!a.target?.player });
    }
    return out;
  }
  // Can the player walk straight at it (no wall, no drop between)?
  function straightTo(id, stop = 1.4) {
    const a = actor(id), p = P();
    if (!a) return false;
    const q = a.motor.position, dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
    if (d <= stop) return true;
    const to = [p.x + (dx / d) * (d - stop), q.y, p.z + (dz / d) * (d - stop)];
    return __pt.walkable([p.x, p.y, p.z], to);
  }
  // A throw at `id`: a Molotov / grenade selected and carried, the target far enough that the
  // blast misses the player (9 m: a creature closing in carries the fire to him), close enough to land (20 m), no ally within 5 m of it, and a
  // clear line from the eye.
  function throwAt(id) {
    const wp = window.__weapons;
    if (!wp || !human()) return null;
    // A flare lights, it does not hurt: the next throwable in the cycle (the throwable key) that
    // is not one, if any.
    const harmless = (t) => !t || /flare/i.test(t.name ?? '');
    for (let n = 0; n < 6 && harmless(wp.service.throwable) && wp.service.throwable; n++) {
      const was = wp.service.throwable.id;
      wp.service.nextThrowable(1);
      if (wp.service.throwable?.id === was) break;
    }
    const th = wp.service.throwable;
    if (harmless(th) || !(th.count > 0)) return null;
    const a = actor(id), p = P();
    if (!a) return null;
    const q = a.motor.position, d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < 9 || d > 20) return null;
    for (const o of __actors.manager.actors) {
      if (!o.alive || o.template || (o.hostile && !__pt.isCompanion(o))) continue;
      if (Math.hypot(o.motor.position.x - q.x, o.motor.position.z - q.z) < 5 || Math.hypot(o.motor.position.x - p.x, o.motor.position.z - p.z) < 3) return null;
    }
    const e = __player.eyePosition(), dx = q.x - e.x, dy = q.y + 1.2 - e.y, dz = q.z - e.z, dd = Math.hypot(dx, dy, dz);
    const hit = __view.collision.raycast(e.x, e.y, e.z, dx / dd, dy / dd, dz / dd, dd);
    if (hit && hit.distance < dd - 0.6) return null;
    return { id: th.id, count: th.count, d: +d.toFixed(1) };
  }
  // A path to it on the planner's grid (a gunman in a side room): ends within `stop` m of it.
  function pathTo(id, stop = 1.4) {
    const a = actor(id), p = P();
    if (!a) return null;
    const q = a.motor.position;
    const r = __pt.plan([p.x, p.y, p.z], [q.x, q.y, q.z], { tol: stop });
    if (!r.ok && r.remaining > stop + 1.2) return null;
    __pt.ap.follow = 0;
    __pt.go(r.pts, 0.5);
    return r.pts.length;
  }
  // The nearest Xombium bottle lying within `r` m about the player's floor that a planned path
  // reaches (`skip`: uids tried already).
  function bottleNear(r = 12, skip = []) {
    const p = P(), w = window.__world?.world;
    if (!w) return null;
    let best = null, bd = r;
    for (const e of w.of('Health Bonus Item')) {
      if (e.destroyed || e.s.taken || !e.visible || !e.enabled || skip.includes(e.uid) || Math.abs(e.pos[1] - p.y) > 1.6) continue;
      const d = Math.hypot(e.pos[0] - p.x, e.pos[2] - p.z);
      if (d < bd) (bd = d), (best = e);
    }
    if (!best || !__pt.plan([p.x, p.y, p.z], best.pos, { tol: 0.9, budget: 2500, shiftBudget: 500 }).ok) return null;
    return { uid: best.uid, pos: best.pos, d: +bd.toFixed(1) };
  }
  // Explosive objects (EXPLOSIVE_TEMPLATES) standing within `r` m of the player.
  function explosivesNear(r = 4) {
    const p = P(), w = window.__world?.world;
    if (!w) return [];
    const out = [];
    for (const e of w.of('Breakable')) {
      const t = e.e?.template;
      if (e.destroyed || !t || !EXPLOSIVE.includes(`${t.pkg}:${t.id}`)) continue;
      const d = Math.hypot(e.pos[0] - p.x, e.pos[2] - p.z);
      if (d < r && Math.abs(e.pos[1] - p.y) < 3) out.push({ uid: e.uid, pos: e.pos, d: +d.toFixed(1) });
    }
    return out;
  }
  // A spot 3..8 m off, walkable straight from here, at least `clear` m from every explosive near.
  function awayFrom(list, clear = 6) {
    const p = P();
    let best = null, bd = Infinity;
    for (let r = 3; r <= 8; r += 1) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2, x = p.x + Math.cos(ang) * r, z = p.z + Math.sin(ang) * r;
        if (list.some((e) => Math.hypot(e.pos[0] - x, e.pos[2] - z) < clear)) continue;
        const h = __pt.floorAt(x, p.y, z, 0.6, 1.0);
        if (h === null || Math.abs(h - p.y) > 0.6 || !__pt.free(x, h, z) || !__pt.walkable([p.x, p.y, p.z], [x, h, z])) continue;
        if (r < bd) (bd = r), (best = [x, h, z]);
      }
      if (best) break;
    }
    return best;
  }
  __pt.tac = { gun, scene, straightTo, pathTo, throwAt, bottleNear, explosivesNear, awayFrom, harmlessUpClose, gunsUp, human };
  return true;
}

export const TACTICS_PAGE = `(${pageTactics.toString()})(${harmlessUpClose.toString()}, ${JSON.stringify(EXPLOSIVE_TEMPLATES)})`;

/**
 * The harness side. `h` is the harness's context: ev, press, keyEv, hold, sideKeys, sleep, note,
 * shortcut, stepTo.
 */
// PT_NO_TACTICS=1: the fight loop without the tactics (an A/B check; ambush steps still run).
const OFF = !!process.env.PT_NO_TACTICS;

export function createTactics(h) {
  const { ev, press, hold, sideKeys, sleep, note, shortcut } = h;
  const said = new Set();
  const once = (kind, why) => {
    if (said.has(kind + why)) return;
    said.add(kind + why);
    shortcut(kind, why);
  };
  const ensure = async () => {
    if (await ev(`!!window.__pt?.tac && window.__pt.tac.__for === window.__pt`).catch(() => false)) return true;
    const ok = await ev(TACTICS_PAGE).catch(() => false);
    if (ok) await ev(`(() => { __pt.tac.__for = __pt; return 1; })()`).catch(() => {});
    return !!ok;
  };
  let crowdPath = null;
  let throwNext = 0;
  let awayNext = 0;
  /** The crowded gunman taken with the blade (page side `__pt.tac.bladeFor`, read by __pt.attack). */
  let bladeFor = 0;
  const setBladeFor = async (id) => {
    bladeFor = id;
    await ev(`(() => { if (window.__pt?.tac) __pt.tac.bladeFor = ${id}; return 1; })()`).catch(() => {});
  };
  let duck = null;
  /** The target the fight loop holds its fire at (page side `__pt.tac.holdFire`, read by its swing). */
  let holdFire = 0;
  const setHoldFire = async (id) => {
    if (holdFire === id) return;
    holdFire = id;
    await ev(`(() => { if (window.__pt?.tac) __pt.tac.holdFire = ${id}; return 1; })()`).catch(() => {});
  };
  const waitNoted = new Set();
  let grabbing = false;
  const bottleTried = new Map();
  const pushNoted = new Set();
  const stats = { crowd: 0, reloads: 0, throws: 0, drinks: 0, transforms: 0, dodges: 0, ducks: 0 };

  /**
   * Reload (the R key's own call: the weapons' keys need pointer lock, logged) when the clip is
   * short and rounds are left.
   */
  const reload = async (frac = 1) => {
    const g = await ev(`__pt.tac.gun()`).catch(() => null);
    const c = g?.cur;
    if (!c || g.busy || c.reserve <= 0 || c.clip >= c.size * frac) return false;
    if (!(await ev(`__weapons.service.reload() !== false`).catch(() => false))) return false;
    once('api', 'reload through services.weapons.reload (the R key needs pointer lock)');
    stats.reloads++;
    // The reload clip (about 1.5 s); a fight loop goes on meanwhile.
    return true;
  };

  /** Drink a bottle (logged): `upTo` keeps the bottle from being wasted on a nearly full bar. */
  const drink = async (why, upTo = 20) => {
    const ok = await ev(`(() => { const c = __actors.combat; return (__hud.model().healthPacks ?? 0) > 0 && c.health <= c.maxHealth - ${upTo} && __weapons.service.useHealthPack(); })()`).catch(() => false);
    if (ok) {
      stats.drinks++;
      once('api', 'Xombium bottle through useHealthPack (the H key needs pointer lock)');
      note(`drank a Xombium bottle (${why}), hp ${await ev('Math.round(__actors.combat.health)')}`);
    }
    return ok;
  };

  /**
   * Ready for a fight the player knows is coming (an ambush trigger, a gunman around the corner):
   * health topped up with bottles (none wasted: each heals about 20), the gun in hand reloaded.
   * `keep`: bottles kept back for during the fight.
   */
  const brace = async ({ hp = 85, keep = 1 } = {}) => {
    if (OFF) return;
    await ensure();
    const s = await ev(`({ hp: __actors.combat.health, max: __actors.combat.maxHealth, packs: __hud.model().healthPacks ?? 0 })`);
    for (let n = braceDrinks(s, { hp, keep }); n > 0; n--) if (!(await drink('bracing for the fight ahead'))) break;
    if (await reload(1)) await sleep(1700);
  };

  /**
   * One tick of the fight loop against `t` (engage()'s pick). Returns true when it took the tick.
   * - A gunman that is harmless up close and in a straight walk: close in (W), shooting when the
   *   line is clear; once in reach stand and shoot (its kick does nothing).
   * - Low with bottles while a gunman is on the player: drink earlier (a volley is up to 15).
   * - Low and out of bottles: run for the nearest one lying within 12 m.
   * - The insanity meter full against a gunman or a group: transform (logged), no ally near.
   * - A throwable against a group of three, or a gunman out of a straight walk.
   * - A blade (a creature without a gun) within 4 m: backed off with a sidestep, shooting.
   * - The gun reloaded in a lull (no one within 6 m, no gun up on the player).
   */
  const kite = { dir: 1, flip: 0 };
  const tick = async (t, { stay = null, area = null } = {}) => {
    if (OFF) return false;
    if (bladeFor && bladeFor !== t?.id) await setBladeFor(0);
    if (!t || stay) return false;
    if (!(await ensure())) return false;
    const s = await ev(`(() => { const sc = __pt.tac.scene(25); const me = sc.find((x) => x.id === ${t.id}); const ta = __actors.manager.actors.find((x) => x.id === ${t.id}); const tg = ta ? { crowd: __pt.tac.harmlessUpClose(ta), onMe: !!ta.target?.player, hunting: ['chase', 'attack', 'shoot', 'hurt'].includes(ta.state), sees: !!ta.seesTarget } : null; const c = __actors.combat; const m = window.__insanity?.model; const pp = __player.position; const allyNear = __actors.manager.actors.some((a) => a.alive && !a.template && (!a.hostile || __pt.isCompanion(a)) && a.entity?.className === 'Unspeakable NPC' && Math.hypot(a.position.x - pp.x, a.position.z - pp.z) < 8); return { sc, me, tg, allyNear, hp: c.health, packs: __hud.model().healthPacks ?? 0, human: __pt.tac.human(), meter: m ? m.s.meter / (m.max || 1) : 0, canMorph: !!m && m.form === 'human' && !m.s.noTransform && (m.available ?? true) && m.s.meter >= m.max - 0.01, shoot: __pt.canShoot(${t.id}) }; })()`).catch(() => null);
    if (!s) return false;
    const gunmenOnMe = s.sc.filter((x) => x.ranged && x.onMe);
    // Not by an explosive: a fight beside a gas can sets it off sooner or later (a blade, a
    // stray round; 1b's ledges, run m2: three cans by the bottles 700e / 700f, 90 at once). With
    // one within 3.5 m and the target within 8 m the player first moves to a spot 6 m clear of
    // them (the target follows him there). Every 4 s at most.
    if (t.d < 8 && Date.now() > awayNext) {
      const ex = await ev(`__pt.tac.explosivesNear(3.5)`).catch(() => []);
      if (ex.length) {
        awayNext = Date.now() + 4000;
        const spot = await ev(`__pt.tac.awayFrom(__pt.tac.explosivesNear(14), 6)`).catch(() => null);
        if (spot) {
          note(`fighting by ${ex.length} explosive object(s) (#${ex.map((e) => e.uid.toString(16)).join(', #')}, ${ex[0].d} m): away to ${spot.map((v) => v.toFixed(1)).join(', ')}`);
          await hold(false);
          await sideKeys([]);
          await h.stepTo(spot, 2.5);
          return true;
        }
      }
    }
    // Out of bottles and low: the one lying nearest (within 12 m, a path to it), as a player runs
    // for it (from the deep link 1b's arena starts with none; its three lie on the arena floor).
    if (s.human && s.packs === 0 && s.hp < 45 && !grabbing) {
      const it = await ev(`__pt.tac.bottleNear(12, ${JSON.stringify([...bottleTried.keys()].filter((u) => bottleTried.get(u) >= 2))})`).catch(() => null);
      if (it) {
        grabbing = true;
        try {
          bottleTried.set(it.uid, (bottleTried.get(it.uid) ?? 0) + 1);
          note(`out of bottles at hp ${Math.round(s.hp)}: for the Xombium bottle #${it.uid.toString(16)} (${it.d} m)`);
          await sideKeys([]);
          await h.walk(it.pos, 0.6, 8, { noFight: true });
          // (Most are taken on touch; else looked at and E.)
          if (!(await ev(`!!__world.world.get(${it.uid})?.s.taken`).catch(() => true))) {
            await ev(`(() => { __pt.ap.follow = 0; __pt.ap.active = false; const w = __world.world.get(${it.uid}); __pt.aimAt(w.pos[0], w.pos[1] + 0.1, w.pos[2]); return 1; })()`).catch(() => {});
            await sleep(300);
            await press('KeyE');
            await sleep(300);
          }
          if (await ev(`!!__world.world.get(${it.uid})?.s.taken`).catch(() => false)) await drink('picked up on the run', 20);
        } finally {
          grabbing = false;
        }
        return true;
      }
    }
    // Earlier drinking under fire: a gunman's attack can take 30.
    if (drinkNow({ hp: s.hp, packs: s.packs, human: s.human, underFire: gunmenOnMe.length > 0 })) await drink(gunmenOnMe.length ? 'under fire' : 'low');
    // The creature form with the meter full when the fight is going badly: a gunman of real
    // health on the player, three hunting at once, two with one within 4 m, or one within 4 m
    // with the player under 60 (1b's arena: a wave of 671a..671f took 65 in one fight while
    // the meter stood full, the arena's own check coming only between fights; runs k1, a1).
    if (s.canMorph && morphNow(s)) {
      const ally = await ev(`(() => { const p = __player.position; return __actors.manager.actors.some((a) => a.alive && (!a.hostile || __pt.isCompanion(a)) && !a.template && a.entity?.className === 'Unspeakable NPC' && Math.hypot(a.position.x - p.x, a.position.z - p.z) < 30); })()`).catch(() => true);
      if (!ally) {
        once('api', 'insanity transform through __insanity.transform (the Q key needs pointer lock)');
        note(`transformed (meter full, ${gunmenOnMe.length ? 'a gunman' : `${s.sc.length} hunting`}, hp ${Math.round(s.hp)})`);
        await hold(false);
        await sideKeys([]);
        await ev(`__insanity.transform()`).catch(() => {});
        stats.transforms++;
        await sleep(1500);
        return true;
      }
    }
    const me = s.me;
    // A throwable at a group (three within 4 m of the target) or at a gunman not in a straight walk.
    if (s.human && me && Date.now() > throwNext) {
      const group = s.sc.filter((x) => Math.abs(x.d - me.d) < 4).length;
      const crowdable = me.crowd && (await ev(`__pt.tac.straightTo(${t.id})`).catch(() => false));
      if (group >= 3 || (me.ranged && me.onMe && !crowdable)) {
        const th = await ev(`__pt.tac.throwAt(${t.id})`).catch(() => null);
        if (th) {
          await hold(false);
          await sideKeys([]);
          once('api', 'Throw through services.weapons.throw (the right mouse button needs pointer lock)');
          await ev(`(() => { const a = __actors.manager.actors.find((x) => x.id === ${t.id}); const q = a.motor.position; __pt.aimAt(q.x, q.y + 1.2, q.z); return 1; })()`);
          await sleep(150);
          if (await ev(`(() => { const a = __actors.manager.actors.find((x) => x.id === ${t.id}); const q = a.motor.position; __pt.aimAt(q.x, q.y + 1.2, q.z); return __weapons.service.throw(); })()`)) {
            stats.throws++;
            // One throw, then 6 s to see what it did (2's east wing: four grenades at one
            // Mainliner in a row, run l2).
            throwNext = Date.now() + 6000;
            note(`threw ${th.id} at #${(me.uid || me.id).toString(16)} (${me.cls}, ${th.d} m${group >= 3 ? `, ${group} together` : ''})`);
            await sleep(600);
            return true;
          }
        }
      }
    }
    // A gunman of that kind that has not seen the player (walking its waypoints, wandering):
    // not chased into the open and not shot at from afar, which only shows him where the player
    // is; he holds his ground, out of its sight, and lets it come (crowded once it hunts him,
    // from a few metres: 1b's 7ffc walks its waypoints, then comes back within 5 m, run x4).
    if (s.human && s.tg?.crowd && !s.tg.hunting && !s.tg.sees && t.d > 5) {
      await setHoldFire(t.id);
      if (!waitNoted.has(t.id)) (waitNoted.add(t.id), note(`#${(t.uid || t.id).toString(16)} has not seen the player (${t.d} m, ${t.st}): waiting out of its sight`));
      await hold(false);
      await sideKeys([]);
      await sleep(150);
      return true;
    }
    if (holdFire) await setHoldFire(0);
    // Duck its volley: its guns up on the player with a line to him, farther than its kick
    // reach, and a spot within 3 m out of every gunman's line (__pt.coverSpot): into it, and held
    // while the guns stay up (3.5 s at most). An Attack is two clips of five rounds; the rounds
    // need the line at each Fire marker, so the clips go to waste, and the gunman then comes
    // round to find him, closer (a corner: crowded from there).
    if (s.human && me?.ranged && me.up && me.onMe && me.d > 2.4 && (!duck || Date.now() > duck.next)) {
      // (Not a spot nearer the gunman than the player stands: run x24 ducked into its path.)
      const spot = await ev(`(() => { if (!__pt.exposed().some((x) => x.id === ${t.id})) return null; const s = __pt.coverSpot(3); const a = __actors.manager.actors.find((x) => x.id === ${t.id}); if (!s || !a) return null; const q = a.motor.position, p = __player.position; return Math.hypot(s[0] - q.x, s[2] - q.z) >= Math.hypot(p.x - q.x, p.z - q.z) ? s : null; })()`).catch(() => null);
      if (spot) {
        stats.ducks++;
        note(`ducking #${(me.uid || me.id).toString(16)}'s volley (${me.cls}, ${me.d} m) into cover ${spot.map((v) => v.toFixed(1)).join(', ')}`);
        await hold(false);
        await sideKeys([]);
        await h.stepTo(spot, 1.5);
        duck = { id: t.id, until: Date.now() + 3500, next: Date.now() + 5000 };
        return true;
      }
    }
    if (duck && duck.id === t.id && Date.now() < duck.until && me?.up) {
      await hold(false);
      await sideKeys([]);
      await sleep(100);
      return true;
    }
    // Crowd the gunman: close in and shoot from inside its kick reach. A straight walk when
    // there is one (the view stays on it), else the planner's path round the wall (replanned
    // every 1.5 s as it moves; the view follows the path).
    if (s.human && me && me.ranged && me.crowd && me.d < 18) {
      if (me.d > 1.7 && !(await ev(`__pt.tac.straightTo(${t.id})`).catch(() => false))) {
        const now = Date.now();
        if (crowdPath?.id !== t.id || now > crowdPath.until || (await ev(`__pt.ap.done`).catch(() => true))) {
          const n = await ev(`__pt.tac.pathTo(${t.id})`).catch(() => null);
          // No way round on the grid but it is close (a door frame, its own body in a narrow
          // room): straight at it all the same, the view on it; the mover slides along what
          // is in the way.
          if (!n && me.d < 6) {
            crowdPath = null;
            if (!pushNoted.has(t.id)) (pushNoted.add(t.id), note(`#${(me.uid || me.id).toString(16)} ${me.d} m off with no planned way in: straight at it`));
            await ev(`(() => { __pt.ap.active = false; __pt.ap.follow = ${t.id}; return 1; })()`).catch(() => {});
            await sideKeys([]);
            await hold(true);
            await sleep(100);
            return true;
          }
          if (!n) return false;
          if (crowdPath?.id !== t.id) note(`closing in on #${(me.uid || me.id).toString(16)} (${me.cls}, ${me.d} m, ${me.st}) round the wall: up close it only kicks`);
          crowdPath = { id: t.id, until: now + 1500 };
        } else await ev(`(() => { __pt.ap.follow = 0; __pt.ap.active = !__pt.ap.done; return 1; })()`);
        stats.crowd++;
        await sideKeys([]);
        await hold(true);
        await sleep(100);
        return true;
      }
      crowdPath = null;
      // Inside its reach the blade (the heaviest carried): a shiv combo is about 25 a second
      // where the revolver is about 9, and every second saved is an Attack fewer (an Attack begun
      // farther off goes on point-blank: 30 taken at 0.8 m, run x5). Back to the gun past 3.5 m.
      if (me.d < 2.2 && bladeFor !== t.id) await setBladeFor(t.id);
      else if (me.d > 3.5 && bladeFor === t.id) await setBladeFor(0);
      if (!stats.crowd++ || me.d > 4) note(`closing in on #${(me.uid || me.id).toString(16)} (${me.cls}, ${me.d} m, ${me.st}): up close it only kicks`);
      await sideKeys([]);
      // (engage() keeps the view on it and fire went out with t: the shot is already taken.)
      if (me.d > 1.5 && !(await ev(`__pt.edgeAhead()`).catch(() => false))) await hold(true);
      else await hold(false);
      await sleep(100);
      return true;
    }
    // Keep out of the blades: a creature without a gun chasing or striking within 4 m while the
    // player has a gun on it: back-pedal with a sidestep (S with A or D, the side changed every
    // 1.2..2.4 s; only where the floor behind is there, __pt.evadeKeys), still shooting. Its
    // blades sweep its front; out of reach it has to come again, and each approach is shots.
    // (Not a Burrower: up only while it strikes, the player stands and shoots.)
    // (Not with a human ally within 8 m: backing off leaves him to the blades; 1a's escort guard
    // 609e is cut down by the gate ambush while the player stands off, run 1a of 2026-10-26.)
    if (!s.allyNear && keepFromBlade(me, s)) {
      const room = await ev(`__pt.evadeKeys(${area ? JSON.stringify(area) : 'null'})`).catch(() => null);
      if (room && !Array.isArray(room)) {
        if (room.pref) kite.dir = room.pref === 'right' ? 1 : -1;
        else if (Date.now() > kite.flip) (kite.dir = -kite.dir), (kite.flip = Date.now() + 1200 + Math.random() * 1200);
        if (kite.dir > 0 && !room.right && room.left) kite.dir = -1;
        else if (kite.dir < 0 && !room.left && room.right) kite.dir = 1;
        const side = kite.dir > 0 ? (room.right ? 'KeyD' : null) : room.left ? 'KeyA' : null;
        if (!stats.dodges++) note(`keeping out of #${(me.uid || me.id).toString(16)}'s blades (${me.cls}, ${me.d} m): backing off and shooting`);
        await hold(false);
        await sideKeys(['KeyS', ...(side ? [side] : [])]);
        await sleep(100);
        return true;
      }
    }
    // A lull: reload (half a clip or less), not with anything close or a gun up on him.
    if (s.human && !s.sc.some((x) => x.d < 6 || (x.ranged && x.up && x.onMe))) {
      if (await reload(0.5)) {
        await sleep(200);
        return false;
      }
    }
    return false;
  };

  /**
   * A scripted ambush the route knows the trigger of (a step `do: 'ambush'`): what hunts the
   * player is fought first; at the waiting spot `back` he braces (bottles, reload; with
   * `brace.morph` the creature form when the meter is full); then he walks into the trigger
   * (`trigger`, a point inside its Detector), at once back to `back` facing `face`, and fights
   * what comes from there until `until` holds (`timeout` s). The creatures then come at him
   * through one opening, not around him where they land.
   */
  const ambush = async (step) => {
    const { walk, fight, checkDeath, cinematic, waitCine } = h;
    await fight(20, false, true);
    await walk(step.back, 0.6, 40);
    await brace(step.brace ?? {});
    if (step.brace?.morph && (await ev(`(() => { const m = window.__insanity?.model; return !!m && m.form === 'human' && !m.s.noTransform && m.s.meter >= m.max - 0.01; })()`).catch(() => false))) {
      once('api', 'insanity transform through __insanity.transform (the Q key needs pointer lock)');
      note('transformed before the ambush (meter full)');
      await ev(`__insanity.transform()`).catch(() => {});
      stats.transforms++;
      await sleep(2500);
    }
    const triggered = step.triggered ? () => ev(step.triggered).catch(() => false) : async () => true;
    for (let n = 0; n < 3 && !(await triggered()); n++) await walk(step.trigger, 0.35, 20, { noFight: true });
    if (!(await triggered())) note(`ambush trigger not reached (${step.triggered})`);
    else note(step.retreat === false ? 'ambush triggered: held there, shooting them as they land' : 'ambush triggered: back to the waiting spot');
    // `retreat: false`: no walk back; the landing (the fall, the landing clip) is seconds of free
    // shots, and turning away to walk lost them (run g1: 24 taken from the pair).
    if (step.retreat !== false) await walk(step.back, 0.6, 10, { noFight: true });
    if (step.face) await ev(`(() => { __pt.aimAt(${step.face.join(',')}); return 1; })()`);
    const end = Date.now() + (step.timeout ?? 120) * 1000;
    let done = false;
    const misses = new Map();
    while (Date.now() < end && !(done = !!(await ev(step.until).catch(() => false)))) {
      await checkDeath();
      if (await cinematic()) {
        await waitCine();
        continue;
      }
      const area = step.hold ? [step.back[0], step.back[2], step.hold] : null;
      const swings = await fight(15, true, false, null, area);
      // One that landed and does not come (it lost sight of the player): gone after, as a player
      // finishes an ambush rather than leave a blade in the hall ahead (`prey`: their uids).
      const prey = !swings && step.prey ? await ev(`(() => { const p = __player.position; let b = null, bd = 1e9; for (const u of ${JSON.stringify(step.prey)}) { const a = __actors.manager.get(u); if (!a?.alive || a.behavior?.kind === 'dormant') continue; const q = a.motor.position, d = Math.hypot(q.x - p.x, q.z - p.z); if (d < bd) (bd = d), (b = { uid: u, pos: [q.x, q.y, q.z], d: +d.toFixed(1) }); } return b; })()`).catch(() => null) : null;
      if (prey && (misses.get(prey.uid) ?? 0) < 3) {
        note(`#${prey.uid.toString(16)} stays where it landed (${prey.d} m): gone after`);
        const r = await walk(prey.pos, 1.2, 20, { area });
        if (!r.arrived) misses.set(prey.uid, (misses.get(prey.uid) ?? 0) + 1);
        continue;
      }
      if (!swings) {
        const far = await ev(`(() => { const p = __player.position; return Math.hypot(p.x - ${step.back[0]}, p.z - ${step.back[2]}) > 3; })()`);
        if (far) await walk(step.back, 0.8, 15);
        else await sleep(500);
      }
    }
    return done;
  };

  return { ensure, tick, brace, reload, drink, ambush, stats };
}
