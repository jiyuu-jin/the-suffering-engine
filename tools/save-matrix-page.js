// Page side of tools/save-matrix.mjs (injected through the playthrough control server's /eval
// after tools/playthrough-restore.js). Not part of the app bundle.
//
// window.__sm:
//   take(id, kind)       fingerprint (playthrough-restore.js snap() + extra()) and a save captured
//                        in the same frame; returns its size and the save veto at that moment.
//   persist(id)          writes the save to the store and reads it back (JSON identical?).
//   restore(id, opts)    restores it (opts.fromStore: read from the store, as after a page
//                        reload) and returns the fingerprint diff taken 2 frames after the save
//                        was applied, plus the save providers' own round trip: a capture right
//                        after the restore compared with the save that was loaded.
//   prep.*               set-ups of the matrix's configurations (see save-matrix.mjs).
(() => {
  if (window.__sm) return 1;
  const r2 = (x) => Math.round(x * 100) / 100;
  /** What the restore fingerprint does not cover: state that outlives the level's systems. */
  const extra = () => {
    const inv = window.__world?.inventory;
    const items = inv?.items ? [...inv.items.values()].map((i) => `${i.template ? `${i.template.pkg}:${i.template.id}` : i.name}x${i.count}`).sort().join(',') : '';
    return {
      'X.flashlight': !!window.__view?.flashlight?.visible,
      'X.crouched': !!window.__player?.crouched,
      'X.mode': window.__player?.mode,
      'X.walking': !!window.__view?.walking,
      'X.health': r2(window.__actors?.combat?.health ?? -1),
      'X.maxHealth': r2(window.__actors?.combat?.maxHealth ?? -1),
      'X.insanity': window.__insanity?.model?.form ?? '-',
      'X.meter': r2(window.__insanity?.model?.s?.meter ?? -1),
      'X.reputation': r2(window.__insanity?.model?.s?.reputation ?? 0),
      'X.difficulty': window.__saves?.session?.difficulty,
      'X.equipped': window.__weapons?.persist?.current ?? null,
      'X.throwable': window.__weapons?.persist?.throwable ?? null,
      'X.blood': window.__repskin?.state?.().blood ?? -1,
      'X.items': items,
      'X.levels': Object.keys(window.__saves?.session?.levels ?? {}).sort().join(','),
      'X.chapter': window.__saves?.session?.chapter ?? '',
    };
  };
  const snap = () => ({ ...window.__ptRestore.snap(), ...extra() });
  const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  const KEYED = [
    [/\.actors\.actors$/, (x, i) => (x?.u !== undefined ? `u${x.u.toString(16)}` : x?.t ? `t${i}` : `#${i}`)],
    [/\.actors\.parts\.a$/, (x) => `u${Number(x?.[0]).toString(16)}`],
    [/\.actors\.removed$/, (x) => `u${Number(x).toString(16)}`],
    [/^game\.archives\.pages$/, (x) => String(x)],
    [/\.actors\.logic\.chains$/, (x) => `u${Number(x?.[0]).toString(16)}`],
    [/\.actors\.specials$/, (x) => `u${Number(x?.[0]).toString(16)}`],
  ];
  /** Leaf paths that differ between two JSON documents (numbers within `tol`). */
  const jsonDiff = (a, b, path = '', out = [], tol = 0.051) => {
    if (out.length > 200) return out;
    if (typeof a === 'number' && typeof b === 'number') {
      if (Math.abs(a - b) > tol) out.push(`${path}: ${r2(a)} -> ${r2(b)}`);
      return out;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      if (Array.isArray(a) !== Array.isArray(b)) return out.push(`${path}: shape`), out;
      // Lists whose order is not state: actors by uid, cut records by uid, removed uids as a set.
      const keyOf = KEYED.find(([re]) => re.test(path))?.[1];
      if (keyOf && Array.isArray(a)) {
        const ka = Object.fromEntries(a.map((x, i) => [keyOf(x, i), x])), kb = Object.fromEntries(b.map((x, i) => [keyOf(x, i), x]));
        return jsonDiff(ka, kb, path, out, tol);
      }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) jsonDiff(a[k], b[k], `${path}.${k}`, out, tol);
      return out;
    }
    if (stable(a) !== stable(b)) out.push(`${path}: ${String(stable(a)).slice(0, 60)} -> ${String(stable(b)).slice(0, 60)}`);
    return out;
  };
  // Provider data that is a clock or per-frame scratch (it moves between the two captures).
  const CLOCK = /(^|\.)(time|t|left|closeIn|clock|elapsed|age|since|at|t0|t1|until|next|timer|playtime|createdAt|ph|tl)(\.|$)|\.rt\.(time|scheduled)|\.(yaw|pitch)$|\.music\.|\.props\.props\.mech\.\d+\.[01]$|\.props\.lights\.ft\.|\.actors\.parts\.a\.[^.]+\.4$/;
  // Values that decay with time (the blood on the skin dries): equal within this much.
  const DECAY = [[/\.blood$/, 1]];
  /**
   * Actor record fields a restore does not keep by design (actors/actor.ts getState): the AI's
   * momentary state (`st`, only 'fall' is restored), a living creature's few centimetres of
   * movement in the frames before the comparison, a dead body's behaviour slot / dormant clip.
   */
  const actorNoise = (p, D, curKey) => {
    // Archive pages are the player profile's (they outlive saves, as the original's
    // Unspeakable.cfg bits do): a load adds the profile's pages, it never takes one away.
    if (/^game\.archives\.pages\.\d+:\d+: undefined -> /.test(p)) return true;
    // A Behavior Changer chain waiting on a body that died: it can never complete either way.
    const ch = /^level\.actors\.logic\.chains\.u([0-9a-f]+): .* -> undefined$/.exec(p);
    if (ch) return (D.levels[curKey]?.actors?.actors ?? []).some((x) => x.u === parseInt(ch[1], 16) && !x.alive);
    const whole = /^level\.actors\.actors\.(u[0-9a-f]+): .* -> undefined$/.exec(p);
    if (whole && sm.immediateDecor?.has(whole[1])) return true;
    const m = /^level\.actors\.actors\.(u[0-9a-f]+|t\d+|#\d+)\.(\w+)(?:\.(\d))?: (.*) -> (.*)$/.exec(p);
    if (!m) return /^level\.actors\.parts\.a\.u[0-9a-f]+\.2: /.test(p) && Math.abs(Number(p.split(': ')[1].split(' -> ')[0]) - Number(p.split(' -> ')[1])) < 0.2;
    const rec = (D.levels[curKey]?.actors?.actors ?? []).find((x) => (x.u !== undefined ? `u${x.u.toString(16)}` : '') === m[1]);
    if (m[2] === 'st') return !/fall/.test(m[4] + m[5]);
    if (rec && !rec.alive && ['bt', 'b', 'bp', 'di', 'ground', 'np'].includes(m[2])) return true;
    if (m[2] === 'p' && rec?.alive) return Math.abs(Number(m[4]) - Number(m[5])) < 0.6;
    // A bleeding or burning creature's health runs down meanwhile.
    // (Or regenerating: a companion's health creeps back.)
    if (m[2] === 'h' && rec?.alive) return Math.abs(Number(m[4]) - Number(m[5])) < 2;
    return false;
  };
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const f = () => (++k >= n ? res() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  });
  const until = async (fn, ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      try {
        if (fn()) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const sm = {
    S0: {},
    S0b: {},
    S0c: {},
    D: {},
    extra,
    snap,
    jsonDiff,
    stable,
    async take(id, kind = 'manual') {
      const veto = window.__saves.canSave();
      // Same frame: the fingerprint and the save.
      const S = snap();
      const D = window.__saves.capture(kind, id);
      if (!D) return { error: 'no level to capture' };
      sm.S0[id] = S;
      sm.D[id] = D;
      // The live level a few frames on (as long as the restore's fingerprint waits): what
      // changes there by itself (a timer about to fire, a creature on the move) is not the save's.
      await frames(3);
      sm.S0b[id] = snap();
      // ... and a second on (compared with the restored level a second after its restore).
      await new Promise((r) => setTimeout(r, 1000));
      sm.S0c[id] = snap();
      const bytes = JSON.stringify(D).length;
      const providers = Object.fromEntries([...Object.entries(D.game).map(([k, v]) => [`game.${k}`, JSON.stringify(v).length]), ...Object.entries(D.levels).flatMap(([lv, ps]) => Object.entries(ps).map(([k, v]) => [`${lv.split('/').pop().split(' ')[0]}.${k}`, JSON.stringify(v).length]))]);
      return { veto, bytes, providers, keys: Object.keys(S).length, level: D.levelName };
    },
    async persist(id) {
      const D = sm.D[id];
      const t0 = performance.now();
      const ok = await window.__saves.store.put(D);
      const wrote = performance.now() - t0;
      const back = await window.__saves.store.get(id);
      return { ok, kind: window.__saves.store.kind, same: !!back && stable(back) === stable(D), diff: back ? jsonDiff(D, back, '', [], 0).slice(0, 8) : ['<missing>'], ms: Math.round(wrote) };
    },
    async restore(id, opts = {}) {
      const st = window.__ptRestore.state;
      const D = opts.fromStore ? await window.__saves.get(id) : sm.D[id];
      if (!D) return { error: 'save not found in the store' };
      st.cp = sm.S0[id];
      st.cpAt = D.createdAt;
      st.restored = null;
      sm.immediate = null;
      const t0 = performance.now();
      const ok = await window.__saves.host.restore(D);
      const done = await until(() => !!st.restored, 90_000);
      const ms = Math.round(performance.now() - t0);
      if (!ok || !done) return { error: `restore ${ok ? 'never applied' : 'failed'}`, ms };
      // The extras and the providers' round trip, at the restored fingerprint's frame.
      Object.assign(st.restored, extra());
      // The providers' round trip: the capture taken right after the save was applied, before
      // any update ran (levelReady hook below): save(load(x)) must give x back. (The late one,
      // with the fingerprint, has frames of play in it.)
      const late = window.__saves.capture('manual', `${id}-after`);
      const D2 = sm.immediate ?? late;
      const d = window.__ptRestore.diff();
      const provDiff = (X) => {
        const out = [];
        for (const [k, v] of Object.entries(D.game)) out.push(...jsonDiff(v, X.game[k], `game.${k}`));
        const cur = Object.keys(X.levels).find((k) => X.levelPath.replace(/\\/g, '/').toLowerCase() === k) ?? Object.keys(X.levels)[0];
        for (const [k, v] of Object.entries(D.levels[cur] ?? {})) out.push(...jsonDiff(v, X.levels[cur]?.[k], `level.${k}`));
        for (const lv of Object.keys(D.levels)) if (lv !== cur && stable(D.levels[lv]) !== stable(X.levels[lv])) out.push(`levels[${lv}] (another level's state) changed`);
        return out;
      };
      // A difference is the providers' when it is there right after the load AND still there in
      // the late capture: only right after = applied on the first update (deferred by design:
      // director chains, behaviours started in the first frame); only late = play went on.
      const latePaths = new Set(provDiff(late).map((p) => p.split(':')[0]));
      const immediate = provDiff(D2);
      const prov = immediate.filter((p) => latePaths.has(p.split(':')[0]));
      const deferred = immediate.length - prov.length;
      const curKey = D.levelPath.replace(/\\/g, '/').toLowerCase();
      const sameExtra = (k, a, b) => {
        if (a === b) return true;
        if (k === 'X.blood') return Math.abs(a - b) < 1;
        // The meter drains in creature form.
        if (k === 'X.meter') return Math.abs(a - b) < 2;
        // The session gains the running level's entry from the save itself.
        if (k === 'X.levels') return String(a).split(',').filter((x) => x && x !== curKey).join(',') === String(b).split(',').filter((x) => x && x !== curKey).join(',');
        return false;
      };
      const extraDiff = Object.keys(extra()).filter((k) => !sameExtra(k, sm.S0[id][k], st.restored[k])).map((k) => `${k}: ${sm.S0[id][k]} -> ${st.restored[k]}`);
      // Objects a sequence attached to a character's hardpoint (sequence.attach) follow the
      // carrier's animation pose, which a save does not hold: their position is soft.
      const attached = new Set((D.levels[curKey]?.['sequence.attach'] ?? []).map((l) => l[0].toString(16)));
      const hard = [], movedSoft = [];
      const liveB = sm.S0b[id];
      for (const h of d.hard) {
        const k = h.split(': ')[0];
        // Restored as the live level itself went on in the same frames: time, not the save.
        if (liveB && k in liveB && liveB[k] !== sm.S0[id][k] && String(liveB[k]).slice(0, 60) === String(st.restored[k]).slice(0, 60)) {
          movedSoft.push(`${h} (as live)`);
          continue;
        }
        // A morph that ended leaves its countdown a hair under zero; a restored one has none.
        const left = /^ins\.morphLeft: (-?[\d.]+) -> (-?[\d.]+)$/.exec(h);
        // A living creature's health running down (bleeding, burning) in the frames between.
        const hp = /^A[0-9a-f]+s?\.health: ([\d.]+) -> ([\d.]+)$/.exec(h);
        // ... or regenerating (Character p8 / p9: a companion heals over time).
        const regen = hp && Number(hp[2]) > Number(hp[1]) && Number(hp[2]) - Number(hp[1]) < 2;
        // Mechanisms swinging (their direction flips at the end of a swing), the lamp's charge.
        const bat = /\.(?:battery|s\.meter|s\.adrenaline|fuse): ([\d.]+) -> ([\d.]+)$/.exec(h);
        // A weapon switch / reload under way (momentary: the original's Player state).
        const soft = /^wep\.service\.busy: /.test(h) || /^props\.mechs\{[0-9a-f]+\}\.dir: /.test(h) || (bat && Math.abs(Number(bat[1]) - Number(bat[2])) < (/battery/.test(h) ? 0.03 : 2)) || (/^D([0-9a-f]+)\.pos:/.test(h) && attached.has(/^D([0-9a-f]+)/.exec(h)[1])) || (left && Number(left[1]) <= 0 && Number(left[2]) <= 0) || (hp && Number(hp[2]) <= Number(hp[1]) && Number(hp[1]) - Number(hp[2]) < 2) || regen;
        (soft ? movedSoft : hard).push(h);
      }
      // What only differs for the first frames (drawn objects the visibility pass shows again,
      // a deferred start): checked once more after a second. Those are `late`, not the save's.
      const late2 = [];
      if (hard.length) {
        await new Promise((r) => setTimeout(r, 1000));
        const S2 = snap();
        for (let i = hard.length - 1; i >= 0; i--) {
          const k = hard[i].split(': ')[0];
          const liveC = sm.S0c[id];
          if (S2[k] === sm.S0[id][k] || (liveB && S2[k] === liveB[k]) || (liveC && k in liveC && S2[k] === liveC[k])) late2.push(...hard.splice(i, 1));
        }
      }
      return {
        ms,
        sameCheckpoint: d.sameCheckpoint,
        hard,
        late: late2,
        soft: d.soft.length + movedSoft.length,
        softSample: d.soft.slice(0, 6),
        extra: extraDiff,
        providers: prov.filter((p) => !CLOCK.test(p.split(':')[0]) && !DECAY.some(([re, tol]) => re.test(p.split(':')[0]) && (([a, b]) => Math.abs(a - b) < tol)(p.split(': ')[1].split(' -> ').map(Number))) && !actorNoise(p, D, curKey)),
        providerClocks: prov.filter((p) => CLOCK.test(p.split(':')[0])).length,
        deferred,
        control: window.__ptRestore.control(),
      };
    },
    /**
     * The level left earlier (`left`, kept in node across the trip) against the level now, after
     * coming back through a transition: the restore page's own comparison rules. The player and
     * the camera are where the arrival put them (another spawn point): not compared.
     */
    revisitDiff(left) {
      const st = window.__ptRestore.state;
      const keep = { cp: st.cp, restored: st.restored, cpAt: st.cpAt, from: st.from };
      st.cp = left;
      st.restored = sm.back.snap;
      st.cpAt = st.from = 1;
      const d = window.__ptRestore.diff();
      Object.assign(st, keep);
      const hard = d.hard.filter((h) => !/^(P\.|X\.(levels|chapter|walking|mode)|E[0-9a-f]+\.s\.inside)/.test(h));
      return { hard, soft: d.soft.length, ignored: d.hard.length - hard.length };
    },
    /**
     * While the play-on check walks about: a Level Transition it walks into does not change the
     * level (the hook that loads the next level is held). Returns whether one was taken.
     */
    holdTransitions(on) {
      const h = window.__world?.world?.hooks;
      if (!h) return false;
      if (on && !sm.heldRequest) {
        sm.heldRequest = h.requestLevel;
        sm.transitionTried = null;
        h.requestLevel = (target, spawn) => (sm.transitionTried = target);
      } else if (!on && sm.heldRequest) {
        h.requestLevel = sm.heldRequest;
        sm.heldRequest = null;
      }
      return sm.transitionTried ?? null;
    },
    /** Live state for the "continue playing" check. */
    probe() {
      const p = window.__player.position;
      return { t: window.__world?.world?.time ?? 0, p: [p.x, p.y, p.z].map(r2), alive: (window.__actors?.combat?.health ?? 0) > 0, enabled: !!window.__player.enabled, override: !!window.__player.motionOverride, veto: window.__saves.canSave(), cine: window.__world.world.activeCutscenes().length };
    },
    frames,
    until,
  };
  // ---------------------------------------------------------------------------------------------
  // Configuration set-ups. Each returns a short note (what it did) or throws.
  const P = () => window.__player.position;
  const ahead = (d) => ({ x: P().x - Math.sin(window.__player.yaw) * d, y: P().y, z: P().z - Math.cos(window.__player.yaw) * d });
  const actorsNear = (r, f = () => true) => window.__actors.manager.actors.filter((a) => !a.kind.decor && !a.template && f(a) && Math.hypot(a.motor.position.x - P().x, a.motor.position.z - P().z) < r);
  const W = () => window.__weapons.service;
  sm.prep = {
    flashlight() {
      W().give('4:72', 1);
      W().give('4:203', 2);
      window.__view.flashlight.visible = true;
      return `flashlight on (${window.__view.flashlight.visible})`;
    },
    lowHealth() {
      const c = window.__actors.combat;
      c.health = Math.min(c.health, 14);
      c.heal?.(0);
      window.__repskin?.setBlood?.(99);
      return `health ${c.health}, blood ${window.__repskin?.state?.().blood}`;
    },
    fullInventory() {
      const kit = [['4:5', 2], ['4:230', 400], ['4:84', 1], ['4:231', 200], ['4:260', 1], ['4:255', 600], ['4:79', 1], ['4:240', 1], ['4:72', 1], ['4:203', 9], ['4:236', 20], ['4:284', 20], ['4:455', 20], ['4:249', 20], ['4:207', 9]];
      for (const [id, n] of kit) W().give(id, n);
      W().equip('4:260');
      return `kit of ${kit.length} templates; equipped ${window.__weapons.persist.current}`;
    },
    equipShotgun() {
      W().give('4:84', 1);
      W().give('4:231', 20);
      W().equip('4:84');
      return `equipped ${window.__weapons.persist.current}`;
    },
    reputation(n) {
      window.__insanity.model.s.reputation = n;
      return `reputation ${n}`;
    },
    async creature() {
      const m = window.__insanity.model;
      // The Toggle Player Insanity Object's "on" (no meter needed: early levels have none).
      // A full meter: an empty one drains the creature's health (rules.ts).
      m.setMeter(m.max);
      m.forceTransform();
      const ok = await until(() => m.form === 'creature', 15_000);
      return `form ${m.form}${ok ? '' : ' (NOT transformed)'}`;
    },
    async morphing() {
      const m = window.__insanity.model;
      if (m.form !== 'human') m.revert(false, true);
      m.setMeter(m.max);
      m.forceTransform();
      await until(() => m.form !== 'human', 3000);
      return `form ${m.form}`;
    },
    /** Back to human at once (after a creature-form configuration). */
    human() {
      const m = window.__insanity.model;
      if (m.form !== 'human') m.revert(false, true);
      return `form ${m.form}`;
    },
    /** Object Cloner copies (the level's template characters) woken next to the player. */
    async fight(n = 2) {
      const M = window.__actors.manager;
      const tpl = M.actors.filter((a) => a.template && a.entity && !a.kind.decor);
      const made = [];
      for (const t of tpl.slice(0, 6)) {
        if (made.length >= n) break;
        const a = M.clone(t.entity.uid);
        if (!a) continue;
        a.relocate?.(ahead(6 + made.length));
        a.dormantHidden = false;
        a.ch.root.visible = true;
        a.wake?.(M.env);
        made.push(a);
      }
      if (!made.length) {
        // No cloner templates: wake the nearest living creatures instead.
        for (const a of actorsNear(40, (a) => a.alive && a.hostile !== false).slice(0, n)) {
          window.__actors.services.actors.wake(a.uid);
          made.push(a);
        }
      }
      await new Promise((r) => setTimeout(r, 2500));
      return `${made.length} creature(s): ${made.map((a) => `${a.kind.name ?? '?'}#${(a.uid ?? 0).toString(16)} ${a.behavior?.cls ?? a.activity ?? ''}`).join(', ') || 'none'}`;
    },
    /** A cut on the nearest creature that has Part Caps (left alive: it bleeds), another killed and cut. */
    dismember() {
      const parts = window.__actors.parts;
      const list = actorsNear(60, (a) => a.alive && parts.has(a)).sort((a, b) => Math.hypot(a.motor.position.x - P().x, a.motor.position.z - P().z) - Math.hypot(b.motor.position.x - P().x, b.motor.position.z - P().z));
      const notes = [];
      const [a, b] = list;
      if (a) {
        const bones = parts.cutBones(a).length;
        const st = [...(parts.st?.get?.(a)?.rules ?? [])];
        const n = st.length ? parts.capLimb(a, st[0].bone) : parts.capLimb(a);
        notes.push(`#${(a.uid ?? 0).toString(16)} cut ${n} (had ${bones}), bleeding ${parts.bleeding(a)}`);
      }
      if (b) {
        window.__actors.services.actors.damage(b, 9999, window.__player.position.clone(), 'player');
        const st = [...(parts.st?.get?.(b)?.rules ?? [])];
        const n = st.length ? parts.capLimb(b, st[st.length - 1].bone) : 0;
        notes.push(`#${(b.uid ?? 0).toString(16)} killed (alive ${b.alive}), cut ${n}`);
      }
      return notes.join('; ') || 'no creature with Part Caps near';
    },
    /** The nearest dead body gibbed (if its rules allow), else killed and gibbed. */
    gib() {
      const G = window.__actors.gibs;
      const list = actorsNear(60, (a) => !!G?.rule?.(a));
      const a = list.find((x) => !x.alive) ?? list[0];
      if (!a) return 'no gibbable creature near';
      if (a.alive) window.__actors.services.actors.damage(a, 9999, window.__player.position.clone(), 'player');
      // A blow of damage type 8 on the body gibs it (gibs.ts GIB_TYPES; type 3, an explosion, throws it).
      for (let i = 0; i < 3 && a.ch.root.visible; i++) window.__actors.services.actors.damage(a, 500, window.__player.position.clone(), 'player', { type: 8 });
      return `#${(a.uid ?? 0).toString(16)} alive ${a.alive}, shown ${a.ch.root.visible}, thrown gibs ${G.thrown?.length ?? '?'}`;
    },
    /** An armed NPC killed (its weapon dropped as a pickup). */
    async npcDrop() {
      const list = actorsNear(80, (a) => a.alive && (window.__weapons.service.npcWeapons?.(a)?.length ?? 0) > 0);
      const a = list[0];
      if (!a) return 'no armed NPC near';
      const drops = () => [...window.__world.world.ents.keys()].filter((u) => u >= 0x7d000000).length;
      const before = drops();
      window.__actors.services.actors.damage(a, 9999, window.__player.position.clone(), 'player');
      // The weapon leaves the hand during the death clip.
      await until(() => drops() > before, 6000);
      return `#${(a.uid ?? 0).toString(16)} killed; dropped objects ${before} -> ${drops()}`;
    },
    /** The player on the nearest ladder (the interact service's own start). */
    async ladder() {
      const I = window.__world.interact;
      const W2 = window.__world.world;
      const lads = [...W2.ents.values()].filter((w) => /ladder/i.test(w.cls));
      if (!lads.length) return 'no ladder';
      if (!I.startLadder) return 'ladder start not exposed';
      // The nearest one (the player is put on its climbing face).
      const dist = (w) => (w.pos ? Math.hypot(w.pos[0] - P().x, w.pos[2] - P().z) : 1e9);
      const near = lads.sort((a, b) => dist(a) - dist(b))[0];
      I.startLadder(near);
      await new Promise((r) => setTimeout(r, 1500));
      return `ladder #${near.uid.toString(16)}: climbing ${!!window.__player.motionOverride}`;
    },
    /**
     * Mounted on a Mountable (`uid`, else the nearest): a gun, a searchlight or crane controls
     * (4b's 7bd9 drives Crane 7a26), turned for a second as the mouse would.
     */
    async mount(uid) {
      const I = window.__world.interact;
      const W2 = window.__world.world;
      const list = [...W2.ents.values()].filter((w) => w.cls === 'Mountable' && !w.destroyed);
      const w = uid ? W2.get(uid) : list.sort((a, b) => Math.hypot(a.pos[0] - P().x, a.pos[2] - P().z) - Math.hypot(b.pos[0] - P().x, b.pos[2] - P().z))[0];
      if (!w) return 'no Mountable';
      I.mount(w);
      for (let i = 0; i < 20; i++) {
        window.__player.yaw += 0.03;
        await frames(1);
      }
      return `mounted #${w.uid.toString(16)}${I.mounted?.crane !== undefined ? ` (crane #${I.mounted.crane.toString(16)})` : ''}: ${!!window.__player.motionOverride}`;
    },
    dismount() {
      window.__world.interact.dismount();
      return `dismounted: ${!window.__player.motionOverride}`;
    },
    /** Mainliners (cloner copies of the level's own, else its placed ones woken) until one rides the player. */
    async ride() {
      const M = window.__actors.manager;
      const isM = (a) => /mainliner/i.test(a.entity?.cls ?? a.entity?.className ?? a.kind?.name ?? '');
      const made = [];
      for (const t of M.actors.filter((a) => a.template && a.entity && isM(a)).slice(0, 2)) {
        const a = M.clone(t.entity.uid);
        if (a) (a.relocate?.(ahead(3 + made.length)), (a.dormantHidden = false), (a.ch.root.visible = true), a.wake?.(M.env), made.push(a));
      }
      if (!made.length) for (const a of actorsNear(60, (x) => x.alive && isM(x)).slice(0, 2)) (a.relocate?.(ahead(3)), window.__actors.services.actors.wake(a.uid), made.push(a));
      window.__actors.combat.invulnerable = true;
      let held = await until(() => !!window.__player.attackOverride, 25_000);
      // Not yet: put them right next to the player, facing him, and wait again.
      if (!held) {
        for (const a of made) a.relocate?.(ahead(1.5));
        held = await until(() => !!window.__player.attackOverride, 25_000);
      }
      return `${made.length} Mainliner(s); riding the player: ${held}`;
    },
    /**
     * A checkpoint requested while a Mainliner rides the player waits (save/system.ts: scripted
     * locomotion) and is taken once the riders are dead.
     */
    async rideCheckpoint() {
      const r = await sm.prep.ride();
      const S = window.__saves;
      const before = S.checkpoint?.createdAt ?? 0;
      S.requestCheckpoint('save matrix: held');
      // Every frame: held while the request waits, and held when it was taken? (The harness
      // mashes the struggle keys, so the hold lasts a few seconds.)
      let heldFrames = 0, takenHeld = null;
      const end = performance.now() + 25_000;
      while (performance.now() < end) {
        await frames(1);
        const held = !!window.__player.motionOverride;
        if ((S.checkpoint?.createdAt ?? 0) > before) {
          takenHeld = held;
          break;
        }
        if (held) heldFrames++;
        else if (heldFrames && !held) {
          // Released: kill the riders so he is not caught again, then wait for the checkpoint.
          for (const a of actorsNear(15, (x) => x.alive && /mainliner/i.test(x.entity?.cls ?? x.kind?.name ?? ''))) window.__actors.services.actors.damage(a, 9999, window.__player.position.clone(), 'player');
        }
      }
      return `${r}; waited held for ${heldFrames} frames; taken while held: ${takenHeld}`;
    },
    /**
     * Thrown objects in the air: the player's flare (thrown with the Flare action) and an NPC's
     * Molotov (services.weapons.throwObject, as an NPC throw: actors/throw.ts).
     */
    async thrown() {
      W().give('4:455', 2);
      W().give('4:249', 2);
      const n0 = window.__weapons.thrown.length;
      W().throwFlare();
      await until(() => window.__weapons.thrown.length > n0, 4000);
      const d = W().def('4:249');
      const by = actorsNear(40, (a) => a.alive)[0];
      const from = { x: P().x - Math.sin(window.__player.yaw) * 3, y: P().y + 1.6, z: P().z - Math.cos(window.__player.yaw) * 3 };
      const ok = d?.thrown && W().throwObject(d.thrown.template, from, { x: 0, y: 14, z: 0 }, by);
      await frames(2);
      return `in the air: ${window.__weapons.thrown.filter((t) => !t.casing).length} (flare ${window.__weapons.thrown.length > n0}, NPC Molotov ${!!ok})`;
    },
    /** A sequence of the level that takes the camera, started out of turn (World.playStomp). */
    async cinematic() {
      const W2 = window.__world.world;
      const cine = () => (W2.playerInCutscene() || W2.activeCutscenes().length > 0) && window.__saves.canSave() === 'cinematic';
      for (const w of [...W2.ents.values()].filter((w) => w.cls === 'STOMP Player' && !w.s.played && !w.destroyed).slice(0, 12)) {
        W2.playStomp(w);
        if (await until(cine, 2500)) return `sequence #${w.uid.toString(16)} playing`;
      }
      return 'no camera sequence found';
    },
  };
  const S = window.__saves;
  // A checkpoint's live continuation (3 frames and a second after it was captured), as take() has.
  const cap = S.capture.bind(S);
  S.capture = (kind, id) => {
    const d = cap(kind, id);
    if (d && kind === 'checkpoint') {
      sm.cpLive = { at: d.createdAt };
      frames(3).then(() => {
        sm.cpLive.b = snap();
        setTimeout(() => (sm.cpLive.c = snap()), 1000);
      });
    }
    return d;
  };
  // Revisits (save-matrix.mjs --revisit): the level as it was left, and as it is when the player
  // comes back through a transition (its state from the session / the loaded save's levels).
  const leaving = S.leavingLevel.bind(S);
  S.leavingLevel = () => {
    try {
      sm.left = { path: window.__world?.world?.opts.levelPath, snap: snap() };
    } catch {}
    leaving();
  };
  const ready = S.levelReady.bind(S);
  S.levelReady = (entry) => {
    ready(entry);
    if (entry.kind === 'transition') {
      sm.back = null;
      frames(3).then(() => (sm.back = { path: window.__world?.world?.opts.levelPath, snap: snap() }));
    }
    if (entry.kind !== 'load') return;
    try {
      sm.immediate = S.capture('manual', 'immediate');
      // Decorations a special turns into actors on its first update (projector.ts): not in a
      // capture taken before it.
      sm.immediateDecor = new Set(window.__actors.manager.actors.filter((a) => a.kind.decor && a.uid !== undefined).map((a) => `u${a.uid.toString(16)}`));
    } catch (e) {
      sm.immediate = null;
    }
  };
  window.__sm = sm;
  return 1;
})()
