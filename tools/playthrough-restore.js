// Page side of the checkpoint-restore check in tools/playthrough.mjs (--deaths). Not part of
// the app bundle. Injected once per page; the hooks sit on the app's SaveManager (`__saves`),
// which outlives levels and restores.
//
// The original restores a checkpoint by rebuilding every object of the level from the saved
// stream (docs/re/saves.md §4.1): right after the restore the level is exactly as it was when
// the checkpoint was taken. So the check compares two broad state fingerprints:
//   - one taken in the same frame the checkpoint is captured (SaveManager.capture 'checkpoint');
//   - one taken a few frames after the restore applied the save (SaveManager.levelReady 'load').
// window.__ptRestore:
//   snap()          the fingerprint: { path: primitive } over world entities (destroyed / enabled /
//                   visible / class state), actors (alive, behaviour, position, health, flags,
//                   behaviour progress), dynamic objects (drawn, position, collision), the player
//                   controller (position, mode, enabled, scripted locomotion), props, insanity,
//                   weapons, music and the level logic around them.
//   diff()          { at, from, hard: [...], soft: [...] } between the last two fingerprints; `hard`
//                   are differences in what the level logic, the actors and the player run on.
//   control()       the player controller after the restore (nothing of the old systems left).
(() => {
  if (window.__ptRestore) return 1;
  // Keys that are references, rebuilt data or per-frame scratch (not state).
  const SKIP = /^(e|tpl|template|kind|clips|clipmap|mesh|geometry|material|skeleton|bones|mixer|ctx|env|world|services|hooks|fs|audio|view|scene|camera|renderer|parent|lib|library|pkgs|cache|nav|graph|collision|motor|pool|batch|buffers?|textures?|lights?|uniforms|raw|data|defs?|map|seq|sequence|tracks|keys|frames|anims?|fx|sounds?|emitters?|model|root|object|obj|node|body3d|skin|byUid|entities|entity|ent|overridden|links|inputs|outputs|bounds|modelRef|values|classHash|className|category|family|catchAll|scale|rotation|w|ch|action|profile|events|look|aimBones|poseHooks|gaitClips|player|box|_.*)$/;
  // Clocks, cooldowns and per-frame AI scratch: they move every frame.
  const NOISY = /(time|Time|clock|phase$|elapsed|age|^t$|^t\d|last|Last|frame|Frame|^dt$|accum|Accum|blink|bob|sway|noise|rand|seed|smooth|lerp|vel|Vel|speed|Speed|yaw|pitch|anim|cycle|Cooldown|cooldown|Delay|delay|until|^id$|occluded|soundsDone|paused|stuck|Stuck|^path|Node$|pathGoal|targetFrom|wish|meleePause|restAcc|body$|bodies|since|Since)/;
  const r2 = (x) => Math.round(x * 100) / 100;
  function snap() {
    const out = {};
    const seen = new WeakSet();
    const walk = (v, path, d) => {
      if (v === null || v === undefined) return void (out[path] = v === null ? 'null' : 'undef');
      const t = typeof v;
      if (t === 'number') return void (out[path] = Number.isFinite(v) ? r2(v) : String(v));
      if (t === 'string' || t === 'boolean') return void (out[path] = v);
      if (t === 'function') return void (out[path] = 'fn');
      if (t !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (v.isObject3D) return void (out[path + '.vis'] = v.visible);
      if (v.isVector3) return void (out[path] = [v.x, v.y, v.z].map(r2).join(','));
      if (v.isQuaternion || v.isMatrix4 || v.isEuler || v.isColor || ArrayBuffer.isView(v) || d <= 0) return;
      if (v instanceof Map) {
        for (const [k, x] of v) if (typeof k !== 'object') walk(x, `${path}{${typeof k === 'number' ? k.toString(16) : k}}`, d - 1);
        return void (out[path + '#'] = v.size);
      }
      if (v instanceof Set) return void (out[path + '#'] = [...v].filter((x) => typeof x !== 'object').map((x) => (typeof x === 'number' ? x.toString(16) : x)).sort().join(',').slice(0, 300));
      if (Array.isArray(v)) {
        out[path + '#'] = v.length;
        return void v.slice(0, 40).forEach((x, i) => walk(x, `${path}[${i}]`, d - 1));
      }
      const proto = Object.getPrototypeOf(v);
      if (proto && proto !== Object.prototype && /Element|Context|Node$|WebSocket|AudioParam|Promise/.test(proto.constructor?.name ?? '')) return;
      for (const k of Object.keys(v)) if (!SKIP.test(k) && !NOISY.test(k)) walk(v[k], `${path}.${k}`, d - 1);
    };
    const W = window.__world?.world;
    if (!W) return out;
    for (const w of W.ents.values()) {
      const p = `E${w.uid.toString(16)}`;
      out[p + '.d'] = w.destroyed;
      out[p + '.en'] = w.enabled;
      out[p + '.vis'] = w.visible;
      walk(w.s, p + '.s', 4);
    }
    for (const a of __actors.manager.actors) {
      if (a.kind?.decor || a.template) continue;
      const p = `A${(a.uid ?? 0).toString(16)}${a.spawned ? 's' : ''}`;
      const q = a.motor.position;
      out[p + '.alive'] = a.alive;
      out[p + '.POS'] = [q.x, q.y, q.z].map((x) => Math.round(x * 2) / 2).join(',');
      out[p + '.beh'] = `${a.behavior?.cls ?? '-'}#${(a.behavior?.uid ?? '').toString(16)}`;
      for (const k of ['health', 'hostile', 'provoked', 'invulnerable', 'ceiling', 'crawler', 'dormantHidden', 'dropOnWake', 'scripted', 'spawned']) walk(a[k], `${p}.${k}`, 1);
      out[p + '.vis'] = a.ch?.root?.visible;
    }
    const P = __player;
    out['P.pos'] = [P.position.x, P.position.y, P.position.z].map((x) => Math.round(x * 4) / 4).join(',');
    for (const k of ['enabled', 'mode', 'crouched', 'bodyYawLock', 'motionOverride', 'attackOverride']) walk(P[k], 'P.' + k, 1);
    const roots = { props: __world.props, interact: __world.interact, blockers: __world.blockers, dir: __actors.director, combat: __actors.combat, ins: window.__insanity?.model, wep: window.__weapons, music: window.__music, levels: window.__levels };
    for (const [name, root] of Object.entries(roots)) {
      try {
        walk(root, name, 4);
      } catch (e) {
        out[name + '!'] = String(e);
      }
    }
    const c = __view.collision;
    for (const [uid, o] of __world.dyn.objects) {
      if (uid >= 0x40000000) continue; // created during play (debris, drops): new uids each time
      // The sky follows the camera.
      if (W.get(uid)?.cls === 'Sky / Sun') continue;
      const p = `D${uid.toString(16)}`;
      const n = o.root;
      if (n) {
        out[p + '.vis'] = n.visible;
        const e = n.matrix.elements;
        out[p + '.pos'] = [e[12], e[13], e[14]].map((x) => Math.round(x * 20) / 20).join(',');
      }
      if (o.body !== undefined) out[p + '.col'] = c.isDynamicEnabled(o.body);
    }
    return out;
  }
  // Not level state: the harness's own invulnerability, the player body's pose rig, the log of
  // director events, spawned debris, play-time ids.
  const IGNORE = /^(combat\.(invulnerable|body)|interact\.use|dir\.(events|log)|props\.(drops|recs\{4|housings\{[0-9a-f]+\}\.spawned))/;
  // What the level logic, the actors and the player run on.
  const HARD = /^(E[0-9a-f]+\.|A[0-9a-f]+s?\.(alive|beh|health|hostile|provoked|invulnerable|dormantHidden|ceiling|crawler|vis)|P\.(enabled|motionOverride|attackOverride|bodyYawLock|mode)|D[0-9a-f]+\.(vis|col|pos)|props\.|ins\.|dir\.(changers|cloners|edges|chains)|wep\.)/;
  const st = { cp: null, cpAt: 0, restored: null, from: 0, applied: 0 };
  const s = window.__saves;
  const cap = s.capture.bind(s);
  s.capture = (kind, id) => {
    const d = cap(kind, id);
    if (d && kind === 'checkpoint') {
      st.cp = snap();
      st.cpAt = d.createdAt;
    }
    return d;
  };
  const ready = s.levelReady.bind(s);
  s.levelReady = (entry) => {
    ready(entry);
    if (entry.kind !== 'load') return;
    st.restored = null;
    st.from = entry.data.createdAt;
    // A few frames: the systems' first updates start what a restore hands them (behaviours,
    // special moves); the original's restore has its objects running at once as well.
    let n = 0;
    const tick = () => {
      if (++n < 2) return void requestAnimationFrame(tick);
      st.restored = snap();
      st.applied = performance.now();
    };
    requestAnimationFrame(tick);
  };
  function diff() {
    if (!st.cp || !st.restored) return { ready: false, sameCheckpoint: false, hard: [], soft: [] };
    const a = st.cp, b = st.restored;
    const hard = [], soft = [];
    // Objects destroyed in both: where they were drawn, their lamp or prop record no longer
    // matter (a lamp shot and then destroyed comes back destroyed with its record 'on').
    const gone = new Set(Object.keys(a).filter((k) => /^E[0-9a-f]+\.d$/.test(k) && a[k] === true && b[k] === true).map((k) => k.slice(1, -2)));
    const goneKey = (k) => {
      const m = /^(?:E([0-9a-f]+)\.vis|D([0-9a-f]+)\.|props\.(?:recs|housings)\{([0-9a-f]+)\})/.exec(k);
      return !!m && gone.has(m[1] ?? m[2] ?? m[3]);
    };
    // Per-frame motion and scratch of the props (mechanisms turning, a grab's axis).
    const PROP_CLOCK = /^props\.(mechs\{[0-9a-f]+\}\.(angle|colAcc)|pushes\{[0-9a-f]+\}\.(axis|offset)|v3|recs#)|^wep\.attach\./;
    // Bodies of spawned creatures: services.actors.spawn ones are not kept by the port's saves
    // (Object Cloner copies are).
    const deadSpawned = new Set(Object.keys(a).filter((k) => /^A[0-9a-f]+s\.alive$/.test(k) && a[k] === false).map((k) => k.split('.')[0]));
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[k] ?? '<none>', y = b[k] ?? '<none>';
      if (x === y || IGNORE.test(k)) continue;
      if (goneKey(k) || PROP_CLOCK.test(k)) {
        soft.push(`${k}: ${String(x).slice(0, 60)} -> ${String(y).slice(0, 60)}`);
        continue;
      }
      // A countdown (a Timer's, a door's auto-close) runs on during the frames before the second
      // fingerprint, and a repeating Timer draws its next one when it fires: a clock, compared as such.
      if (/\.s\.(left|closeIn)$/.test(k)) {
        if (typeof x !== 'number' || typeof y !== 'number') hard.push(`${k}: ${x} -> ${y}`);
        continue;
      }
      // Dynamic objects: positions within 0.15 m (the fingerprint rounds to 0.05; what a character
      // carries moves with its pose).
      if (/^D[0-9a-f]+\.pos$/.test(k) && typeof x === 'string' && typeof y === 'string') {
        const u = x.split(',').map(Number), v = y.split(',').map(Number);
        if (u.length === 3 && v.length === 3 && u.every((n, j) => Math.abs(n - v[j]) <= 0.15)) continue;
      }
      // A dead body's behaviour slot (its DeathBehavior or the one it had): not run any more.
      if (/^A[0-9a-f]+s?\.beh$/.test(k) && a[k.replace(/beh$/, 'alive')] === false && b[k.replace(/beh$/, 'alive')] === false) {
        soft.push(`${k}: ${x} -> ${y} (dead)`);
        continue;
      }
      if (deadSpawned.has(k.split('.')[0]) && y === '<none>') {
        soft.push(`${k}: (spawned corpse not kept)`);
        continue;
      }
      (HARD.test(k) ? hard : soft).push(`${k}: ${String(x).slice(0, 60)} -> ${String(y).slice(0, 60)}`);
    }
    return { ready: true, sameCheckpoint: st.from === st.cpAt, hard: hard.sort(), soft: soft.sort() };
  }
  function control() {
    const P = __player;
    return { motionOverride: !!P.motionOverride, bodyYawLock: P.bodyYawLock ?? null, enabled: P.enabled, attackOverride: !!P.attackOverride };
  }
  window.__ptRestore = { snap, diff, control, state: st };
  return 1;
})()
