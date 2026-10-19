// Scenarios of tools/specials-qa.mjs (one per special move / boss). Page JS strings run in the
// game page: `setup` once, `act` + `sample` every `every` ms for `duration` s; `shots` are the
// sample times (s) that go into the screenshot strip; `check(report)` returns problems.
// Helpers: window.__qa (tools/specials-qa.mjs), __specials (src/game/actors/specials/index.ts),
// __actors, __world, __player, __view.

const SEEN = `window.__seen = []; __world.world.subscribe('*', (m, f, t) => { if (__seen.length < 4000) __seen.push([+__world.world.time.toFixed(2), t, m, f]); });`;
const ev = (r, re) => (r.events ?? []).filter((e) => re.test(e.what));
const hpDrop = (r) => {
  const h = r.samples.map((s) => s.player?.hp).filter((x) => typeof x === 'number');
  return h.length ? h[0] - Math.min(...h) : 0;
};

export default function (scenario) {

  // 1a: the Horace fight. Relay #7a4b (what STOMP #80d2 fires) starts it; QuestStart (350)
  // makes him attack at once; each volley's end sends 350 (shields down); the five Breakables
  // #8570.. are broken one by one (each -> Relay #8589 -> Triggered: Horace's stage + 1); then
  // the Switch #8588 (Triggered) -> STOMP #8399 -> Relay #839d BlowUp ends him.
  scenario('horace', {
    level: '1a',
    duration: 70,
    every: 250,
    shots: [1, 5, 9, 13, 17, 21, 30, 45, 65],
    setup: `${SEEN}
      const h = __qa.actor(0x7a47); __qa.stage(h, 7); __player.setMode('tp'); __qa.face(h);
      const w = __world.world; w.send(0x7a4b, 1, 0);
      window.__t0 = performance.now(); window.__brk = [0x8570, 0x8572, 0x8573, 0x8575, 0x8576];
      return { horace: __qa.st(h) };`,
    act: `
      const t = (performance.now() - __t0) / 1000; const w = __world.world; const h = __qa.actor(0x7a47);
      if (__actors.combat.health < 45) __actors.combat.heal(100);
      if (h.alive) __qa.face(h);
      if (t > 2 && !window.__q) { window.__q = 1; w.send(0x7a47, 350, 0); }
      // After each volley (its 350 lowers the shields) the player breaks one Breakable.
      // While he shoots (his 350 lowered the shields) the player breaks a Breakable (a still
      // shielded one is tried again every second).
      const hz = __specials.get(0x7a47)?.info.hz;
      if (__brk.length && (hz === 'volley' || hz === 'gap') && (!window.__tt || t - __tt > 1)) { window.__tt = t; const u = __brk[0]; const e = w.get(u);
        __world.damage.apply({ point: { x: e.pos[0], y: e.pos[1], z: e.pos[2] }, amount: 500, kind: 1, source: 'player', targetUid: u });
        if (w.get(u)?.destroyed) { __brk.shift(); window.__tb = t; window.__qs = t + 3; } }
      // The level's Speech Players answer with QuestStart (350): Horace attacks at once.
      if (window.__qs && t >= __qs) { window.__qs = 0; w.send(0x7a47, 350, 0); }
      // All five down: the player uses Switch #8588 (the world's use path); retried until it takes.
      if (!__brk.length && t - (window.__tb ?? 1e9) > 3 && h.alive && (!window.__sw || t - __sw > 5)) { window.__sw = t; window.__swn = (window.__swn ?? 0) + 1; window.__swr = w.useSwitch(w.get(0x8588)); }
      if (window.__sw && w.activeCutscenes().length) w.skipCutscenes();`,
    sample: `const w = __world.world; const h = __qa.actor(0x7a47); const s = __specials.get(0x7a47)?.info ?? {};
      return { label: 'horace ' + (s.hz ?? '?') + ' stage ' + ((s.stage ?? 0) + 1) + (h.alive ? '' : ' DEAD'), player: __qa.player(), s, alive: h.alive,
        sw: window.__swn ?? 0, swr: window.__swr, switchOpen: !!w.get(0x8588)?.s.open, seq: [0x8398, 0x8399, 0x839d].filter((u) => __seen.some((x) => x[1] === u)).map((u) => u.toString(16)),
        relays: [0x83ae, 0x8591, 0x8589, 0x8592, 0x839d].filter((u) => __seen.some((x) => x[1] === u)).map((u) => u.toString(16)) };`,
    check: (r) => {
      const p = [];
      const last = r.samples[r.samples.length - 1] ?? {};
      if (!ev(r, /volley:/).length) p.push('no volley');
      if (!ev(r, /volley: .* sends 350/).length) p.push('no 350 with a volley');
      if (!ev(r, /stage [2-6]/).length) p.push('stage never advanced');
      if (!(hpDrop(r) > 0)) p.push('no damage to the player');
      if (last.alive) p.push('Horace still alive at the end');
      return p;
    },
  });

  // 4a: a fresh Inferna (template 10:823) at #75c2's spot, the player 10 m away: it ignites,
  // circles, throws fireballs / bursts into flame, takes no damage while burning (only its
  // flame time goes down), burns out to an ash pile that can be killed.
  scenario('inferna', {
    level: '4a',
    duration: 45,
    every: 250,
    shots: [0.5, 2.5, 5, 9, 14, 20, 27, 34, 42],
    setup: `window.__i = __qa.spawnAt({ pkg: 10, id: 823 }, 0x75c2, 10); window.__t0 = performance.now(); return { at: __i.position };`,
    act: `
      const t = (performance.now() - __t0) / 1000;
      if (__actors.combat.health < 45) __actors.combat.heal(100);
      __qa.face(__i);
      if (!window.__ls || t - __ls > 1) { window.__ls = t; const p = __i.position;
        __world.damage.apply({ point: { x: p.x, y: p.y + 1, z: p.z }, amount: 6, kind: 1, source: 'player', actor: __i }); }`,
    sample: `const s = __specials.of(__i) ?? {};
      return { label: (s.inf ?? '?') + ' ' + (s.act ?? '') + ' hp ' + __qa.r(__i.health) + ' flame ' + s.flame, player: __qa.player(), s, inf: __qa.st(__i) };`,
    check: (r) => {
      const p = [];
      const s = r.samples.map((x) => x.s ?? {});
      if (!ev(r, /ignites/).length) p.push('never ignited');
      if (!ev(r, /flame attack|fireball/).length) p.push('never attacked');
      if (!s.some((x) => x.absorbed > 0)) p.push('no damage absorbed by the flame');
      if (!ev(r, /burns out/).length) p.push('never burnt out');
      if (!(hpDrop(r) > 0)) p.push('no damage to the player');
      return p;
    },
  });

  // 5b: the Killjoy fight. Projector #1501 On, KilljoyRoot via Relay #1513, invulnerability off
  // (Relay #32fe). His corpses (#150f..#1512) lie dead: he walks over and raises them. The five
  // projectors are broken one by one; the last one's 10000 damage kills him and Relay #1bf8 runs.
  scenario('killjoy', {
    level: '5b',
    duration: 45,
    every: 250,
    shots: [1, 4, 8, 13, 18, 24, 30, 36, 42],
    setup: `${SEEN}
      const k = __qa.actor(0x1500); __qa.stage(k, 9); __player.setMode('tp'); __qa.face(k);
      const w = __world.world; w.send(0x1501, 1, 0); w.send(0x32fe, 1, 0); w.send(0x1513, 1, 0);
      window.__t0 = performance.now(); window.__pj = [0x1502, 0x1503, 0x2b0a, 0x1505, 0x1506];
      return { killjoy: __qa.st(k), corpses: [0x150f, 0x1510, 0x1511, 0x1512].map((u) => __qa.st(__qa.actor(u))) };`,
    act: `
      const t = (performance.now() - __t0) / 1000; const w = __world.world; const k = __qa.actor(0x1500);
      if (__actors.combat.invulnerable !== true) __actors.combat.invulnerable = true;
      if (k?.alive) __qa.face(k);
      if (t > 14 && __pj.length && (!window.__lb || t - __lb > 4)) { window.__lb = t; const u = __pj.shift(); const e = w.get(u);
        // A shot at the projector (what the player's bullet does once it hits its actor).
        const pa = __qa.actor(u); window.__pr = (window.__pr ?? []).concat([{ u: u.toString(16), actor: !!pa, inv: pa?.invulnerable, hp: pa?.health }]);
        // #1503 is not on Relay #32fe's list: the level lowers its shield later; do it here.
        if (pa?.invulnerable) w.send(u, 91, 0);
        if (pa) __world.damage.apply({ point: { x: pa.position.x, y: pa.bottom + 0.5, z: pa.position.z }, amount: 20, kind: 1, source: 'player', actor: pa }); }
      if (w.activeCutscenes().length && t > 30) w.skipCutscenes();`,
    sample: `const w = __world.world; const k = __qa.actor(0x1500); const s = __specials.get(0x1500)?.info ?? {};
      const mat = k?.ch.mesh.material; const op = Array.isArray(mat) ? mat[0].opacity : mat?.opacity;
      return { label: 'killjoy ' + (s.kj ?? '?') + ' raises ' + (s.raises ?? 0) + ' op ' + __qa.r(op ?? 1) + (k?.alive ? '' : ' DEAD'), player: __qa.player(), s, alive: !!k?.alive, opacity: op,
        corpses: [0x150f, 0x1510, 0x1511, 0x1512].map((u) => __qa.actor(u)?.alive), projectors: [0x1502, 0x1503, 0x2b0a, 0x1505, 0x1506].map((u) => __qa.actor(u)?.alive ?? null), pr: window.__pr,
        relays: [0x164c, 0x1bf8, 0x1bf9, 0x15ac].filter((u) => __seen.some((x) => x[1] === u)).map((u) => u.toString(16)) };`,
    check: (r) => {
      const p = [];
      const last = r.samples[r.samples.length - 1] ?? {};
      if (!ev(r, /raised from the dead/).length) p.push('no corpse raised');
      if (new Set(r.samples.map((x) => x.opacity).filter((x) => x !== undefined)).size < 3) p.push('opacity never changed');
      if (last.alive) p.push('Killjoy still alive');
      if (!(last.relays ?? []).includes('1bf8')) p.push('completion Relay #1bf8 not reached');
      return p;
    },
  });

  // 1b: a fresh Slayer creature (class CartWheeler, template 10:24): a bullet on the body hurts
  // the body only; one on its head (bone 18) breaks the 3-HP head off (gibs), the creature
  // staggers and lives on; an explosion does not touch the head.
  scenario('heads', {
    level: '1b',
    duration: 10,
    every: 250,
    shots: [0.5, 2.6, 3.2, 4.5, 7],
    setup: `window.__c = __qa.spawnAt({ pkg: 10, id: 24 }, 0x6208, 5); window.__t0 = performance.now(); window.__log = [];
      __actors.combat.invulnerable = true; return { at: __c.position, hp: __c.health };`,
    act: `
      const t = (performance.now() - __t0) / 1000; const c = __c; __qa.face(c);
      const head = () => { const b = c.ch.skeleton.bones[18]; b.updateWorldMatrix(true, false); const v = b.getWorldPosition(new b.position.constructor()); return { x: v.x, y: v.y, z: v.z }; };
      const shot = (what, point, kind) => { const hp = c.health; __world.damage.apply({ point, amount: 2, kind, source: 'player', actor: c }); __log.push({ t: +t.toFixed(1), what, before: hp, after: c.health, head: __specials.of(c)?.head }); };
      if (t > 1 && !window.__s1) { window.__s1 = 1; shot('body bullet', { x: c.position.x, y: c.bottom + 0.5, z: c.position.z }, 1); }
      if (t > 1.5 && !window.__s2) { window.__s2 = 1; shot('head explosion', head(), 3); }
      if (t > 2 && !window.__s3) { window.__s3 = 1; shot('head bullet', head(), 1); }
      if (t > 2.5 && !window.__s4) { window.__s4 = 1; shot('head bullet', head(), 1); }`,
    sample: `const s = __specials.of(__c) ?? {}; return { label: 'head ' + s.head + ' hp ' + __qa.r(__c.health) + ' ' + __c.state, s, c: __qa.st(__c) };`,
    final: `return { log: __log, s: __specials.of(__c), alive: __c.alive };`,
    check: (r) => {
      const p = [];
      const log = r.final?.log ?? [];
      const body = log.find((x) => x.what === 'body bullet');
      if (!body || !(body.after < body.before)) p.push('body bullet did not hurt the body');
      if (log.some((x) => x.what.startsWith('head') && x.after !== x.before)) p.push('a head hit hurt the body');
      if (r.final?.s?.head !== 'off') p.push('head not shot off');
      const off = log.filter((x) => x.what === 'head bullet').pop();
      if (!off || !(off.after > 0)) p.push('decapitation killed it');
      return p;
    },
  });

  // 1b: a fresh Slayer (10:527, ranged) 18 m from the player picks a Ranged Targeting Position
  // in its band, walks there and shoots from it.
  scenario('ranged', {
    level: '1b',
    duration: 25,
    every: 250,
    shots: [1, 5, 10, 16, 22],
    setup: `window.__s = __qa.spawnAt({ pkg: 10, id: 527 }, 0x77fb, 16); __actors.combat.invulnerable = true; window.__t0 = performance.now(); return { at: __s.position, stands: __specials.ranged.stands.length };`,
    act: `__qa.face(__s);`,
    sample: `return { label: __s.activity, s: __qa.st(__s), stats: __specials.ranged.stats };`,
    check: (r) => {
      const p = [];
      if (!ev(r, /takes stand/).length) p.push('no stand taken');
      return p;
    },
  });

  // 1b arena (Object Cloner template #7e08's spot): a fresh Fester 12 m from the player. It
  // charges (5..20 m band), strikes; bullets (type 1) bounce off its armour; after 11 s of
  // fighting it releases rats (SpawnRat markers) and is open to bullets while they come out.
  scenario('fester', {
    level: '1b',
    duration: 30,
    every: 200,
    shots: [0.5, 1.6, 2.4, 3.2, 6, 11.5, 12.5, 14, 20],
    setup: `window.__f = __qa.spawnAt({ pkg: 10, id: 363 }, 0x7e08, 12); window.__t0 = performance.now(); window.__shots = [];
      return { at: __f.position };`,
    act: `
      const t = (performance.now() - __t0) / 1000;
      __qa.face(__f);
      if (__actors.combat.health < 40) __actors.combat.heal(100);
      // After the charge, keep backing off (rats only come when the target is beyond 2 m).
      if (t > 9 && (!window.__lb || t - __lb > 2.5) && Math.hypot(__f.position.x - __player.position.x, __f.position.z - __player.position.z) < 4) { window.__lb = t; __qa.stage(__f, 6); }
      // A revolver shot at the chest every 2 s (services.damage, bullet type 1).
      if (!window.__ls || t - __ls > 2) { window.__ls = t; const p = __f.position; const before = __f.health;
        const at = { x: p.x, y: __f.bottom + __f.height * 0.6, z: p.z };
        __shots.push({ t: +t.toFixed(1), hp: before, open: !!__specials.of(__f)?.vulnerable, ret: JSON.stringify(__world.damage.apply({ point: at, amount: 8, kind: 1, source: 'player', actor: __f }).hits) }); }`,
    sample: `const s = __specials.of(__f) ?? {};
      return { label: (s.fs ?? '?') + ' hp ' + __qa.r(__f.health) + ' rats ' + (s.rats ?? 0), player: __qa.player(), fester: __qa.st(__f), s, rats: __qa.byClass('Rat').filter((r) => r.spawned && r.alive).length };`,
    final: `return { shots: __shots, s: __specials.of(__f) };`,
    check: (r) => {
      const p = [];
      if (!ev(r, /charges from/).length) p.push('never charged');
      if (!ev(r, /charge connects|charge strike/).length && !ev(r, /skid/).length) p.push('charge never ended');
      if (!ev(r, /releases a rat/).length) p.push('no rats released');
      if (!(hpDrop(r) > 0) && !ev(r, /charge strike/).length) p.push('no damage to the player');
      return p;
    },
  });

  // 1b arena: a fresh Mainliner 6 m from the player leaps, sticks and rides; once the player
  // struggles (jump / direction presses) it is thrown off or finishes.
  scenario('mainliner', {
    level: '1b',
    duration: 20,
    every: 120,
    shots: [0.3, 0.6, 0.9, 1.3, 1.8, 2.4, 3.5, 6, 12],
    setup: `window.__m = __qa.spawnAt({ pkg: 10, id: 176 }, 0x8bd6, 6); window.__t0 = performance.now(); return { at: __m.position };`,
    act: `
      const t = (performance.now() - __t0) / 1000;
      if (__actors.combat.health < 40) __actors.combat.heal(100);
      const st0 = __specials.of(__m); const st = st0?.ml === 'ride' ? st0 : undefined;
      // First ride: no struggle (finisher); later rides: mash.
      window.__rides = st ? Math.max(window.__rides ?? 0, st.rides) : (window.__rides ?? 0);
      if (st && st.rides > 1) { window.__k = (window.__k ?? 0) + 1; __player.jump(); __player.setVirtualInput(__k % 2 ? { forward: 1, strafe: 0 } : { forward: 0, strafe: 1 }); }
      else __player.setVirtualInput(null);
      if (!st) __qa.face(__m);`,
    sample: `const s = __specials.of(__m) ?? {};
      return { label: (s.ml ?? '?') + (s.held ? ' HELD' : '') + ' ride ' + (s.ride ?? 0), player: __qa.player(), ml: __qa.st(__m), s };`,
    check: (r) => {
      const p = [];
      if (!ev(r, /leaps/).length) p.push('never leapt');
      if (!ev(r, /sticks to the player/).length) p.push('never stuck');
      if (!ev(r, /finisher|thrown off|jumps off/).length) p.push('ride never ended');
      if (!(hpDrop(r) > 0)) p.push('no damage to the player');
      return p;
    },
  });

  // 1b: a fresh Burrower 14 m from the player travels underground (direct hits do nothing),
  // makes fly-by passes and surfaces to strike.
  scenario('burrower', {
    level: '1b',
    duration: 30,
    every: 200,
    shots: [0.5, 2, 4, 6, 8, 11, 14, 18, 24],
    setup: `window.__b = __qa.spawnAt({ pkg: 10, id: 256 }, 0x7e1a, 14); window.__t0 = performance.now(); window.__hits = [];
      return { at: __b.position };`,
    act: `
      const t = (performance.now() - __t0) / 1000;
      __qa.face(__b);
      if (__actors.combat.health < 40) __actors.combat.heal(100);
      if (!window.__ls || t - __ls > 1.5) { window.__ls = t; const p = __b.position;
        const r = __world.damage.apply({ point: { x: p.x, y: p.y + 0.5, z: p.z }, amount: 5, kind: 1, source: 'player', actor: __b });
        __hits.push({ t: +t.toFixed(1), st: __specials.of(__b)?.bw, hp: __qa.r(__b.health) }); }`,
    sample: `const s = __specials.of(__b) ?? {};
      return { label: (s.bw ?? '?') + ' ' + __b.state + ' hp ' + __qa.r(__b.health), player: __qa.player(), bw: __qa.st(__b), s };`,
    final: `return { hits: __hits, s: __specials.of(__b) };`,
    check: (r) => {
      const p = [];
      const s = r.final?.s ?? {};
      if (!(s.blocked > 0)) p.push('no direct hit was blocked underground');
      if (!ev(r, /fly-by/).length) p.push('no fly-by');
      if (!(s.emerges > 0)) p.push('never emerged');
      if (!(hpDrop(r) > 0)) p.push('no damage to the player');
      return p;
    },
  });

  // 1a: Nooseman #8408 (group of Drop Position #88ce). The player stands under #88c9; On wakes
  // the Nooseman, which drops, grabs and strangles; after ~2.5 s of the hold the player
  // struggles (jump presses) and breaks free.
  scenario('nooseman', {
    level: '1a',
    duration: 16,
    every: 150,
    shots: [0.3, 0.9, 1.6, 2.6, 4, 5.5, 7, 9, 12],
    setup: `
      const d = __world.world.get(0x88c9).pos;
      const g = __view.collision.raycast(d[0], d[1] - 0.3, d[2], 0, -1, 0, 20);
      const feet = { x: d[0], y: d[1] - 0.3 - g.distance, z: d[2] };
      __player.spawn(feet, 0); __player.setMode('tp'); __player.pitch = 0.35;
      __actors.combat.invulnerable = false;
      __world.world.send(0x8408, 1, 0); __world.world.send(0x8409, 1, 0);
      window.__t0 = performance.now();
      return { feet, drop: d };`,
    act: `
      const t = (performance.now() - __t0) / 1000;
      const st = __specials.get(0x8408)?.info;
      window.__mashOn ||= st?.nm === 'grapple' && st.meter > 2.4;
      if (window.__mashOn && st?.nm === 'grapple') { window.__mash = (window.__mash ?? 0) + 1; __player.jump(); __player.setVirtualInput(__mash % 2 ? { forward: 1, strafe: 0 } : { forward: 0, strafe: 1 }); }
      else __player.setVirtualInput(null);
      if (__actors.combat.health < 30) __actors.combat.heal(100);`,
    sample: `
      const n = [0x8408, 0x8409].map((u) => __specials.get(u)?.info ?? {});
      const a = __qa.actor(0x8408);
      return { label: n.map((x) => x.nm + (x.held ? ' HELD m=' + x.meter : '')).join(' | '), player: __qa.player(), n0: n[0], n1: n[1], drawn0: a.drawn };`,
    check: (r) => {
      const p = [];
      if (!ev(r, /drops at/).length) p.push('never dropped');
      if (!ev(r, /grabs the player/).length) p.push('never grabbed');
      const dealt = Math.max(0, ...r.samples.map((s) => Math.max(s.n0?.dealt ?? 0, s.n1?.dealt ?? 0)));
      if (!(dealt > 5)) p.push(`strangle damage ${dealt}`);
      if (!ev(r, /breaks free/).length) p.push('player never broke free');
      if (!ev(r, /hides/).length) p.push('never reeled back up and hid');
      return p;
    },
  });
  // 10 Docks: the four Black Ones. The intro sequence's Relay a85 sends On to #822; the
  // player shoots the heart (services.damage on the holder) until the last stage breaks;
  // Died (p76) -> Relay b25 -> Timer 12a8 -> 12c8 -> the reputation's ending movie.
  scenario('black-one', {
    level: '10',
    duration: 75,
    every: 250,
    shots: [1, 4, 8, 14, 22, 30, 40, 52, 64],
    setup: `${SEEN}
      __insanity.model.s.reputation = 0;
      const w = __world.world; w.send(0xa87, 1, 0);
      const bo = __qa.actor(0x822);
      __qa.stage(bo, 9); __player.setMode('tp'); __qa.face(bo);
      w.send(0xa85, 1, 0);
      window.__boT = performance.now();
      return { members: __specials.list().filter((m) => m.bo !== undefined).map((m) => m.uid.toString(16)), heart: __specials.get(0x822).info };`,
    act: `
      const t = (performance.now() - __boT) / 1000;
      const f = __specials.list().find((m) => m.holder);
      const holder = f && __qa.actor(f.uid);
      if (holder) __qa.face(holder);
      // The player takes the boss's blows but is healed before they would kill him.
      if (__actors.combat.health < 45) __actors.combat.heal(100);
      // Shooting the heart: 12 damage every 0.5 s while it can be hurt.
      if (holder && f.vulnerable && t > 6 && (!window.__lastShot || t - __lastShot > 0.5)) {
        window.__lastShot = t;
        window.__dmg = (window.__dmg ?? 0) + 1;
        __actors.services.actors.damage(holder, 12, __player.position, 'player');
      }`,
    sample: `
      const list = __specials.list().filter((m) => m.bo !== undefined);
      const h = list.find((m) => m.holder) ?? list[0];
      return { label: h ? 'stage ' + (h.stage + 1) + ' heart ' + h.heart + ' ' + h.bo + (h.attack ? ' atk ' + h.attack : '') : '', player: __qa.player(),
        bo: list.map((m) => m.uid.toString(16) + ':' + m.bo).join(' '), stage: h?.stage,
        render: h ? (() => { const a = __qa.actor(h.uid); return { mesh: a.ch.mesh.visible, root: a.ch.root.visible, occ: a.occluded, dh: a.dormantHidden, pos: __qa.st(a).pos, h: __qa.r(a.height), bottom: __qa.r(a.bottom), anchored: a.kind.anchored }; })() : null, heart: h?.heart, done: h?.done,
        ending: [0xb25, 0x12a8, 0x12c8, 0xb26, 0xb39, 0xb3a].filter((u) => __seen.some((s) => s[1] === u)).map((u) => u.toString(16)),
        endingAfter: (() => { const d = __seen.find((s) => s[2] === 19 && [0x7f4, 0x820, 0x821, 0x822].includes(s[3])); return d ? [0xb25, 0x12a8, 0x12c8, 0xb26, 0xb39, 0xb3a].filter((u) => __seen.some((s) => s[1] === u && s[0] >= d[0])).map((u) => u.toString(16)) : []; })() };`,
    check: (r) => {
      const p = [];
      const last = r.samples[r.samples.length - 1] ?? {};
      if (!ev(r, /activated/).length) p.push('never activated');
      if (!ev(r, /attack slot/).length) p.push('never attacked');
      if (!(hpDrop(r) > 0) && !ev(r, /^blow|^fireball \d/).length) p.push('the player took no damage');
      if (!ev(r, /stage 3/).length) p.push('never reached stage 3');
      if (!ev(r, /Died \(p76\) fired/).length) p.push('Died not fired');
      const died = ev(r, /Died \(p76\) fired/)[0]?.t ?? 1e9;
      if (!(last.endingAfter ?? []).includes('b25')) p.push('Relay b25 not reached after Died');
      if (!(last.endingAfter ?? []).includes('b26')) p.push('neutral ending movie b26 not started');
      return p;
    },
  });
}
