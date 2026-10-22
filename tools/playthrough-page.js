// Page side of tools/playthrough.mjs (injected with Runtime.evaluate after every level start,
// checkpoint restore and load). Not part of the app bundle.
//
// window.__pt:
//   plan(from, to, {tol})   A* over a 0.4 m walkable grid probed from the collision world
//                           (ground queries + a step-lifted capsule); closed doors the player can
//                           open count as passable. Returns smoothed waypoints.
//   go(path) / ap           per-frame autopilot: turns the view (yaw) towards the next waypoint;
//                           the harness holds the real move key (W) and releases it on arrival.
//   blockingDoor()          the closed openable door in the way of the current leg.
//   standFor(uid) / center  where to stand to use an object / its world-space centre.
//   aimAt(x, y, z)          look at a point (the mouse-look equivalent; headless has no pointer lock).
//   engage(range)           pick the nearest creature hunting the player and keep the view on it.
//   reach()                 flood the walkable grid: enabled Detectors, closed usable Switches and
//                           pickups within reach (route discovery).
//   state() / metrics() / sanity()   probes for the per-step report.
//   dmg / seen / checkpoints         logs: player damage, level messages, checkpoints.
(() => {
  // The Gameplay option "Always Run" (the original's run-by-default): the harness holds W only.
  if (window.__player && 'alwaysRun' in window.__player) window.__player.alwaysRun = true;
  const old = window.__pt;
  if (old?.ap) old.ap.active = false;
  const STEP = 0.4, R = 0.32, H = 1.75, STEP_UP = 0.42, DROP = 1.3;
  const col = () => __view.collision;
  // Plan with the player's collision layers: Invisible Static Object player clips stop the player
  // (src/game/world/blockers.ts), so the planner must see them too.
  const asPlayer = (fn) => {
    const c = col(), L = c.queryLayers;
    c.queryLayers = __player.motor?.layers ?? L;
    try { return fn(c); } finally { c.queryLayers = L; }
  };
  const floorAt = (x, y, z, up = 0.5, down = 2.2) => {
    const g = asPlayer((c) => c.groundQuery(x, y + up, z, 0.2, up + down));
    if (!g || !g.walkable) return null;
    // Water holds nobody up and drowns the player deeper than Player p28 (2 m;
    // src/game/levels/water.ts): a bed under deeper water is no floor. A step's `noWater` keeps
    // the route out of any water (10's sea under the dock has no way back up).
    const s = __fx?.waterSurfaces?.at?.(x, g.height + 0.05, z);
    if (s !== undefined && s > g.height && (window.__ptAvoidWater || s - g.height > 1.9)) return null;
    return g.height;
  };
  const free = (x, h, z) => asPlayer((c) => !c.capsuleOverlaps({ x, z, y0: h + STEP_UP + R, y1: h + H - R, r: R }));
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  // Closed doors the player can open (unlocked, usable, moving kind): passable for planning.
  function openableDoors() {
    const w = __world.world;
    // Door-sized only: a lever or button (3b's basement lever 2177, 0.8 m) pressed on the way
    // toggled what the route's own use step then toggled back.
    const doorSized = (d) => { const o = __world.dyn.objects.get(d.uid); if (!o) return false; const b = __world.dyn.bounds(o); return b.max.y - b.min.y >= 1.6; };
    return w.of('Switch').filter((d) => !d.destroyed && d.visible && d.s.unlocked && !d.s.open && !d.s.moving && w.switchUsable(d) && d.s.motion?.kind !== 'none' && __world.dyn.objects.get(d.uid)?.body !== undefined && doorSized(d));
  }
  function withDoorsOpen(fn) {
    const c = col(), saved = [];
    for (const d of openableDoors()) {
      const b = __world.dyn.objects.get(d.uid).body;
      saved.push([b, c.isDynamicEnabled(b)]);
      c.setDynamicEnabled(b, false);
    }
    try { return fn(); } finally { for (const [b, on] of saved) c.setDynamicEnabled(b, on); }
  }
  // The closed openable door in the way of the autopilot's next leg (within 2.5 m).
  function blockingDoor() {
    const p = P();
    const t = ap.path[ap.idx] ?? [p.x, p.y, p.z];
    let best = null, bd = 2.5;
    for (const d of openableDoors()) {
      const c = center(d.uid);
      const dd = Math.hypot(c[0] - p.x, c[2] - p.z);
      if (dd > bd || Math.abs(c[1] - 1 - p.y) > 2) continue;
      // Ahead of the player towards the waypoint.
      const vx = t[0] - p.x, vz = t[2] - p.z, vl = Math.hypot(vx, vz) || 1;
      if (((c[0] - p.x) * vx + (c[2] - p.z) * vz) / (vl * (dd || 1)) < 0.2) continue;
      bd = dd; best = d;
    }
    // Stuck against a door whose middle is beside or behind the player (3b: the cell-block door
    // 9e3 swung across the corridor the player stood in): the door the body meets on the leg.
    if (!best && ap.stuck >= 1) {
      const vx = t[0] - p.x, vz = t[2] - p.z, vl = Math.hypot(vx, vz) || 1;
      const hit = asPlayer((c) => c.sphereCast(p.x, p.y + 0.9, p.z, R, vx / vl, 0, vz / vl, 1.0));
      const uid = hit?.dynamic !== undefined ? __world.dyn.uidOfBody(hit.dynamic) : undefined;
      if (uid !== undefined) best = openableDoors().find((d) => d.uid === uid) ?? null;
    }
    return best ? best.uid.toString(16) : null;
  }
  function plan(from, to, opts = {}) {
    const run = (f, o = opts) => (o.doors === false ? planRaw(f, to, o) : withDoorsOpen(() => planRaw(f, to, o)));
    let r = run(from);
    // Narrow gaps (a hole in a window) can fall between the 0.4 m grid's cells: try the grid
    // shifted by half a step before giving up. A failed search covers everything reachable
    // (seconds on a busy page): the shifted ones get a smaller time budget.
    for (const [dx, dz] of [[0.2, 0], [0, 0.2], [0.2, 0.2]]) {
      if (r.ok) break;
      const r2 = run([from[0] + dx, from[1], from[2] + dz], { ...opts, budget: opts.shiftBudget ?? 3000 });
      if (r2.ok) r = { ...r2, pts: [from, ...r2.pts] };
    }
    // Pressed against a shelf in a fight (8b's store room), the start cell can have no free
    // neighbour: start again from a free spot up to 0.8 m away.
    for (const d of [0.4, 0.8]) {
      if (r.ok || r.pts.length > 1) break;
      for (const [dx, dz] of DIRS) {
        const f = [from[0] + dx * d, from[1], from[2] + dz * d];
        const h = floorAt(f[0], f[1], f[2]);
        if (h === null || Math.abs(h - from[1]) > STEP_UP || !free(f[0], h, f[2])) continue;
        const r2 = run([f[0], h, f[2]], { ...opts, budget: opts.shiftBudget ?? 3000 });
        if (r2.ok || r2.pts.length > 1) {
          r = { ...r2, pts: [from, ...r2.pts] };
          break;
        }
      }
    }
    return r;
  }
  function planRaw(from, to, opts = {}) {
    const tol = opts.tol ?? 0.6, maxN = opts.max ?? 80000;
    // Time budget (ms): a failing search expands up to maxN nodes at ~0.5 ms each when the page
    // is busy; without a cap one unreachable goal cost minutes per try.
    const budget = opts.budget ?? 20000;
    const t0 = performance.now();
    const ox = from[0], oz = from[2];
    let h0 = floorAt(from[0], from[1], from[2]);
    if (h0 === null) h0 = from[1];
    const key = (i, k, h) => `${i},${k},${Math.round(h * 2)}`;
    const nodes = new Map();
    const open = [];
    const push = (n) => { open.push(n); let i = open.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (open[p].f <= open[i].f) break; [open[p], open[i]] = [open[i], open[p]]; i = p; } };
    const pop = () => { const top = open[0]; const last = open.pop(); if (open.length) { open[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < open.length && open[l].f < open[m].f) m = l; if (r < open.length && open[r].f < open[m].f) m = r; if (m === i) break; [open[m], open[i]] = [open[i], open[m]]; i = m; } } return top; };
    const hfun = (x, y, z) => Math.hypot(x - to[0], (y - to[1]) * 1.5, z - to[2]);
    const start = { i: 0, k: 0, x: ox, z: oz, y: h0, g: 0, f: hfun(ox, h0, oz), prev: null };
    nodes.set(key(0, 0, h0), start);
    push(start);
    let best = start, bestH = start.f, n = 0, goal = null;
    let timedOut = false;
    while (open.length && n < maxN) {
      const c = pop();
      if (c.closed) continue;
      c.closed = true;
      n++;
      if ((n & 255) === 0 && performance.now() - t0 > budget) { timedOut = true; break; }
      const hd = Math.hypot(c.x - to[0], c.z - to[2]);
      if (hd <= tol && Math.abs(c.y - to[1]) < 1.6) { goal = c; break; }
      const hh = hfun(c.x, c.y, c.z);
      if (hh < bestH) (bestH = hh), (best = c);
      for (const [di, dk] of DIRS) {
        const i = c.i + di, k = c.k + dk;
        const x = ox + i * STEP, z = oz + k * STEP;
        // opts.drop: the deepest drop to take (default DROP; up to 6 m is harmless: fall damage
        // starts at 6.5 m).
        const drop = opts.drop ?? DROP;
        const fh = floorAt(x, c.y, z, 0.9, drop + 0.9);
        if (fh === null) continue;
        const dy = fh - c.y;
        if (dy < -drop || dy > 2 * STEP_UP) continue;
        if (dy > STEP_UP) {
          // Stairs: two half steps of at most STEP_UP each.
          const mh = floorAt((x + c.x) / 2, c.y, (z + c.z) / 2);
          if (mh === null || mh - c.y > STEP_UP || fh - mh > STEP_UP) continue;
        }
        const kk = key(i, k, fh);
        const ex = nodes.get(kk);
        if (ex?.closed) continue;
        if (!free(x, fh, z)) continue;
        if (di && dk && !free((x + c.x) / 2, Math.max(fh, c.y), (z + c.z) / 2)) continue;
        const g = c.g + Math.hypot(di, dk) * STEP + Math.max(0, -dy) * 0.5;
        if (ex && ex.g <= g) continue;
        const nn = ex ?? { i, k, x, z, y: fh };
        nn.g = g; nn.f = g + hfun(x, fh, z) * 1.05; nn.prev = c;
        nodes.set(kk, nn);
        push(nn);
      }
    }
    const end = goal ?? best;
    const pts = [];
    for (let c = end; c; c = c.prev) pts.push([c.x, c.y, c.z]);
    pts.reverse();
    return { ok: !!goal, pts: smooth(pts), expanded: n, timedOut, ms: Math.round(performance.now() - t0), end: [end.x, end.y, end.z], remaining: +Math.hypot(end.x - to[0], end.z - to[2]).toFixed(2) };
  }
  // Straight walk between two points is fine when every 0.3 m sample is standable and
  // continuous in height ...
  function walkable(a, b) {
    const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.max(1, Math.ceil(d / 0.3));
    let h = a[1];
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
      const fh = floorAt(x, h, z);
      if (fh === null || fh - h > STEP_UP || h - fh > 0.6 || !free(x, fh, z)) return false;
      h = fh;
    }
    // ... and ends at b's height: from a walkway the samples find the walkway itself over a
    // point on the floor below it (3a's arrival walkway: the walk went to its railing).
    return Math.abs(h - b[1]) <= 0.6;
  }
  function smooth(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 40);
      while (j > i + 1 && !walkable(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
  const P = () => __player.position;
  const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
  const ap = { active: false, path: [], idx: 0, last: [0, 0, 0], lastT: 0, stuck: 0, done: false, moved: 0 };
  __view.onFrame((dt) => {
    if (window.__pt?.ap !== ap || !window.__actors || !window.__world) return;
    if (ap.follow) {
      const a = __actors.manager.actors.find((x) => x.id === ap.follow);
      if (!a || a.health <= 0 || a.state === 'dead') { ap.follow = 0; return; }
      const q = a.motor.position, e = __player.eyePosition();
      const dx = q.x - e.x, dz = q.z - e.z;
      __player.yaw = yawTo(dx, dz);
      // At the body's middle: 1 m up passed over 3a's rats (0.46 m tall) and they were never hit.
      __player.pitch = Math.atan2(q.y + Math.min(1.0 * (a.scale ?? 1), 0.55 * (a.height ?? 1.8)) - e.y, Math.hypot(dx, dz));
      return;
    }
    if (!ap.active) return;
    const p = P();
    while (ap.idx < ap.path.length - 1 && Math.hypot(ap.path[ap.idx][0] - p.x, ap.path[ap.idx][2] - p.z) < (ap.pass ?? 0.45)) ap.idx++;
    const t = ap.path[ap.idx];
    const d = Math.hypot(t[0] - p.x, t[2] - p.z);
    if (ap.idx === ap.path.length - 1 && d < (ap.tol ?? 0.4)) {
      ap.done = true;
      ap.active = false;
      // Let go of W here, on the frame of arrival: the harness's own key-up comes one round
      // trip later, and at a run (or a slow frame) that carried the player metres past the
      // spot (1a: out of the cell into the corridor's far side).
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }));
      return;
    }
    const want = yawTo(t[0] - p.x, t[2] - p.z);
    if (ap.turn) {
      // A player's mouse: the view turns towards the next point at a limited rate (rad/s), so
      // corners are rounded and the view sweeps as it would by hand (stroll steps).
      let dy = want - __player.yaw;
      dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
      const step = ap.turn * Math.min(0.1, dt || 1 / 60);
      __player.yaw += Math.max(-step, Math.min(step, dy));
    } else __player.yaw = want;
    __player.pitch = 0;
    const now = performance.now();
    if (now - ap.lastT > 1500) {
      const m = Math.hypot(p.x - ap.last[0], p.z - ap.last[2]);
      ap.stuck = m < 0.35 ? ap.stuck + 1 : 0;
      ap.last = [p.x, p.y, p.z];
      ap.lastT = now;
    }
  });
  // `turn` (rad/s): turn the view at that rate instead of snapping it; `pass`: distance (m) at
  // which an intermediate point counts as passed.
  function go(path, tol, turn = 0, pass = 0.45) {
    Object.assign(ap, { active: true, path, idx: 0, done: false, stuck: 0, last: [P().x, P().y, P().z], lastT: performance.now(), tol, turn, pass });
    return path.length;
  }
  // Seconds an actor (level uid) is drawn on screen while a sequence runs, from its start for
  // `secs` (sequences that are not cinematics have no "running" flag the harness can poll).
  const sceneWatch = (window.__ptSceneWatch ??= {});
  function watchScene(seq, uid, secs) {
    const k = `${seq}:${uid}`;
    if (sceneWatch[k]) return sceneWatch[k];
    const r = (sceneWatch[k] = { seq, uid, secs, start: null, seen: 0, frames: 0, first: null });
    let last = null;
    __view.onFrame(() => {
      const w = window.__world?.world;
      if (!w || r.done) return;
      const now = w.time;
      if (r.start === null) {
        if (!w.get(seq)?.s.played) return;
        r.start = now;
      }
      if (now - r.start > secs) {
        r.done = true;
        return;
      }
      const s = window.__pt?.onScreen?.(uid);
      if (s) {
        if (last !== null) r.seen += now - last;
        r.frames++;
        r.first ??= { t: +(now - r.start).toFixed(2), ...s };
      }
      last = now;
    });
    return r;
  }
  function aimAt(x, y, z) {
    const e = __player.eyePosition();
    const dx = x - e.x, dy = y - e.y, dz = z - e.z;
    __player.yaw = yawTo(dx, dz);
    __player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
  function state() {
    const p = P();
    const c = __actors.combat;
    return { p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], hp: c.health, alive: c.health > 0, en: __player.enabled, ground: __player.onGround, cine: __world.world.activeCutscenes().map((s) => s.name), ap: { active: ap.active, done: ap.done, idx: ap.idx, n: ap.path.length, stuck: ap.stuck } };
  }
  function hostiles(range = 25) {
    const p = P();
    return __actors.manager.actors.filter((a) => a.health > 0 && a.state !== 'dead' && a.ch.root.visible && (a.hostile || a.provoked) && !isCompanion(a)).map((a) => {
      const q = a.motor.position;
      return { id: a.id, uid: a.entity?.uid, kind: a.kind?.name ?? a.entity?.cls, st: a.state, hp: a.health, d: +Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z).toFixed(2), pos: [q.x, q.y, q.z] };
    }).filter((a) => a.d < range).sort((a, b) => a.d - b.d);
  }
  const V3 = __player.position.constructor;
  // World-space centre of an object's meshes (doors / switches: the hinge is the placement).
  function center(uid) {
    const d = __world.dyn.objects.get(uid);
    const w = __world.world.get(uid);
    if (!d) return w ? [w.pos[0], w.pos[1] + 1, w.pos[2]] : null;
    const acc = new V3(); let n = 0;
    d.root.updateWorldMatrix(true, true);
    d.root.traverse((o) => {
      const g = o.geometry;
      if (!g || !o.isMesh) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const c = g.boundingBox.getCenter(new V3()).applyMatrix4(o.matrixWorld);
      acc.add(c); n++;
    });
    if (!n) return [w.pos[0], w.pos[1] + 1, w.pos[2]];
    acc.multiplyScalar(1 / n);
    return [acc.x, acc.y, acc.z];
  }
  /**
   * A clear line of fire from the eye at feet (x, y, z) (default: the player's) to an object's
   * centre: nothing before it, or its own body first (10's valves 357 / 35a behind the pushed crate 318).
   */
  function lineTo(uid, x, y, z) {
    const c = center(uid);
    if (!c) return false;
    const p = P(), e = __player.eyePosition();
    const ex = x ?? p.x, ey = (y ?? p.y) + (e.y - p.y), ez = z ?? p.z;
    const dx = c[0] - ex, dy = c[1] - ey, dz = c[2] - ez, l = Math.hypot(dx, dy, dz);
    const hit = col().raycast(ex, ey, ez, dx, dy, dz, l);
    if (!hit || hit.distance > l - 0.35) return true;
    return hit.dynamic !== undefined && __world.dyn.uidOfBody(hit.dynamic) === uid;
  }
  /** A stand near (x, y, z) (rings out to `r` m) with a clear line to the object, or null. */
  function lineStand(uid, x, y, z, r = 3) {
    if (lineTo(uid, x, y, z)) return [x, y, z];
    for (let d = 0.6; d <= r; d += 0.6) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2, sx = x + Math.cos(a) * d, sz = z + Math.sin(a) * d;
        const h = floorAt(sx, y, sz);
        if (h === null || Math.abs(h - y) > 0.5 || !free(sx, h, sz)) continue;
        if (lineTo(uid, sx, h, sz)) return [sx, h, sz];
      }
    }
    return null;
  }
  // Where to look to use an object: a Switch's fit-test anchor nearest the player (the original
  // offers a door only to a player facing that point within the template's p6, by the handle;
  // docs/game-logic.md §14.5 "Use target"), else the centre of its meshes.
  function useAim(uid) {
    const w = __world.world.get(uid);
    const a = w && w.cls === 'Switch' ? __world.interact.switchAnchors?.(w) ?? [] : [];
    if (!a.length) return center(uid);
    const p = P();
    a.sort((u, v) => Math.hypot(u.x - p.x, u.z - p.z) - Math.hypot(v.x - p.x, v.z - p.z));
    return [a[0].x, a[0].y, a[0].z];
  }
  // Where to stand to use an object: in front of a door (perpendicular to hinge -> centre),
  // on the side nearer the player; other objects: 1 m from the centre towards the player.
  function standFor(uid, dist = 1.1, all = false) {
    const c = center(uid), w = __world.world.get(uid), p = P();
    let ax = c[0] - w.pos[0], az = c[2] - w.pos[2];
    const l = Math.hypot(ax, az);
    const dirs = [];
    if (w.cls === 'Switch' && l > 0.4) {
      ax /= l; az /= l;
      dirs.push([-az, ax], [az, -ax]);
    } else {
      const dx = p.x - c[0], dz = p.z - c[2], d = Math.hypot(dx, dz) || 1;
      dirs.push([dx / d, dz / d]);
      for (let k = 1; k < 8; k++) { const a = Math.atan2(dz, dx) + (k * Math.PI) / 4; dirs.push([Math.cos(a), Math.sin(a)]); }
    }
    const out = [];
    for (const [nx, nz] of dirs) for (const r of [dist, dist + 0.4, dist - 0.3, dist + 0.8]) {
      const x = c[0] + nx * r, z = c[2] + nz * r;
      // Floors from the object's height down to 2.5 m below; the capsule must fit there.
      const h = floorAt(x, Math.max(w.pos[1], c[1]), z, 0.3, 3.2);
      if (h === null || c[1] - h > 2.4 || !free(x, h, z)) continue;
      out.push({ x, h, z, score: Math.hypot(x - p.x, z - p.z) + Math.abs(r - dist) * 2 });
    }
    // A Switch's own approach points first (the template's fit test: 3b's cell lever 13d5 is
    // only usable from its east side, the nearest spots were on the west).
    if (w.cls === 'Switch') {
      for (const a of __world.interact.switchApproaches?.(w) ?? []) {
        const h = floorAt(a.x, a.y + 0.5, a.z, 0.3, 1.5);
        if (h !== null && free(a.x, h, a.z)) out.push({ x: a.x, h, z: a.z, score: -1 });
      }
    }
    out.sort((a, b) => a.score - b.score);
    if (!out.length) {
      // (A list for `all`: useObj walks to each spot in turn.)
      const p0 = [c[0] + dirs[0][0] * dist, w.pos[1], c[2] + dirs[0][1] * dist];
      return all ? [p0] : p0;
    }
    if (all) {
      // Distinct spots (>= 0.6 m apart), best first.
      const pick = [];
      for (const o of out) if (pick.every((q) => Math.hypot(q[0] - o.x, q[2] - o.z) > 0.6)) pick.push([o.x, o.h, o.z]);
      return pick.slice(0, 6);
    }
    return [out[0].x, out[0].h, out[0].z];
  }
  // Combat: pick the nearest live hostile that is hunting the player (or close by) and keep
  // the view on it. Returns its distance (the harness walks in / fires) or null.
  // `area` [x, z, r]: only creatures within r m of (x, z) (an arena step's `hold`).
  // 6b's Clem (49a) fights creatures with a KillEnemies from the start (the port marks him
  // `hostile`), but never the player: an ally as the others.
  // (9 Lighthouse's bc9, carried to 10 Docks as 7b8: their uids are only companions there.)
  const lvlPath = __world.world.opts.levelPath ?? '';
  const COMPANIONS = [0x7569, 0x868, 0x49a, ...(/9 Lighthouse/.test(lvlPath) ? [0xbc9] : []), ...(/10 Docks/.test(lvlPath) ? [0x7b8] : [])];
  const isCompanion = (a) => COMPANIONS.includes(a.entity?.uid) && !a.target?.player && !a.grudge?.player;
  function engage(range = 20, all = false, huntOnly = false, area = null) {
    const p = P();
    let best = null, bd = Infinity, bk = Infinity;
    for (const a of __actors.manager.actors) {
      if (a.health <= 0 || a.state === 'dead' || !a.ch.root.visible || a.dormantHidden) continue;
      // Whoever is after a companion (1c's inmate, 2's Dallas) is fought first, as a player
      // defending him would (the three inmates of 2's middle block turn on him, not hostile by
      // kind).
      const onAlly = !!a.target?.actor?.alive && COMPANIONS.includes(a.target.actor.entity?.uid) && ['chase', 'attack', 'shoot'].includes(a.state);
      if (!(a.hostile || a.provoked || onAlly) || isCompanion(a)) continue;
      // A step's `spare` list: characters a player leaves alone (the Prelude's fleeing guards).
      if ((window.__ptSpare ?? []).includes(a.entity?.uid)) continue;
      if (area && Math.hypot(a.motor.position.x - area[0], a.motor.position.z - area[1]) > area[2]) continue;
      if ((ap.memo?.get(a.id)?.until ?? 0) > performance.now()) continue;
      // Allies (the escort guard) fight creatures, not the player.
      if (!a.hostile && !onAlly && !(a.target?.player || a.grudge?.player)) continue;
      const q = a.motor.position;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (Math.abs(q.y - p.y) > 3) continue;
      const hunting = onAlly || ['chase', 'attack', 'shoot', 'hurt'].includes(a.state);
      if (!hunting && (d > 6 || huntOnly) && !all) continue;
      const dd = onAlly ? d - 8 : d;
      if (dd < bk && d < range) (bk = dd), (bd = d), (best = a);
    }
    // A creature that takes no damage for 8 s while engaged (out of reach behind a shelf, up in
    // a hole; outside arena mode only while it is within 3 m: behind the 2 Cellblocks yard fence)
    // is left alone for 30 s.
    // (Not a Burrower: underground it takes no hits by design and surfaces only to strike, 4b /
    // 5a; set aside, it went on striking a player who no longer fought back.)
    // Also one "chasing" from further off that has not moved in those 8 s (5b's attic: a
    // Mainliner copy chasing in place 4.6 m away held every walk for minutes).
    if (best && (all || bd < 3 || best.state === 'chase') && best.entity?.className !== 'Burrower') {
      const now = performance.now(), memo = (ap.memo ??= new Map());
      const m = memo.get(best.id);
      const q = best.motor.position;
      // After its 30 s off, a fresh 8 s try (the old `since` had already run out, so the creature
      // was set aside again at once and never fought again: the 1b arena's last copy attacked an
      // invulnerable player for the rest of the 600 s).
      if (!m || m.hp !== best.health || (m.until && now >= m.until)) memo.set(best.id, { hp: best.health, since: now, until: 0, x: q.x, z: q.z });
      else if (!all && bd >= 3 && Math.hypot(q.x - m.x, q.z - m.z) > 0.5) {
        // A chaser on its way: watch it afresh from here.
        m.since = now;
        m.x = q.x;
        m.z = q.z;
      } else if (now - m.since > 8000) {
        m.until = now + 30000;
        m.since = now;
        best = null;
      }
    }
    ap.follow = best ? best.id : 0;
    if (best) ap.active = false;
    return best ? { id: best.id, uid: best.entity?.uid ?? 0, d: +bd.toFixed(2), st: best.state, hp: +best.health.toFixed(1) } : null;
  }
  // Player damage log (who hurt the player, how much, and the call site).
  const dmg = old?.dmg ?? [];
  const c = __actors.combat;
  if (c && !c.__ptWrapped) {
    const orig = c.damage.bind(c);
    c.damage = (amount, from) => {
      const before = c.health;
      orig(amount, from);
      const st = (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().replace(/https?:\/\/[^/]+\//, '').replace(/\?t=\d+/, '')).join(' < ');
      dmg.push({ t: +__world.world.time.toFixed(2), amount: +amount.toFixed(1), hp: +c.health.toFixed(1), was: +before.toFixed(1), from: from ? (from.entity?.uid ?? from.id).toString(16) + ' ' + (from.entity?.cls ?? '') : '', inv: c.invulnerable, at: st });
      if (dmg.length > 200) dmg.shift();
    };
    c.__ptWrapped = true;
  }
  // Damage to characters on the player's side (companions: what killed the 2 Cellblocks inmate).
  const allyDmg = old?.allyDmg ?? [];
  const mgr = __actors.manager;
  if (mgr && !mgr.__ptWrapped) {
    const orig = mgr.damage.bind(mgr);
    mgr.damage = (a, amount, from, by, hit) => {
      const before = a?.health;
      const r = orig(a, amount, from, by, hit);
      if (a && (!a.hostile || COMPANIONS.includes(a.entity?.uid)) && a.entity && !a.template) {
        const who = typeof by === 'object' && by ? (by.entity?.uid ?? by.id ?? '').toString(16) + ' ' + (by.entity?.className ?? '') : String(by ?? '');
        allyDmg.push({ t: +__world.world.time.toFixed(2), uid: a.entity.uid.toString(16), amount: +(+amount).toFixed(1), was: +(+before).toFixed(1), hp: +a.health.toFixed(1), by: who, type: hit?.type });
        if (allyDmg.length > 300) allyDmg.shift();
      }
      return r;
    };
    mgr.__ptWrapped = true;
  }
  // Flood the walkable grid from the player: enabled Detectors and usable closed Switches /
  // pickups within reach (route discovery).
  function reach(maxN = 40000, doors = true) {
    if (doors) return withDoorsOpen(() => reach(maxN, false));
    const p = P();
    const w = __world.world;
    const dets = w.of('Detector').filter((d) => !d.destroyed && d.enabled && d.box);
    const sws = w.of('Switch').filter((d) => !d.destroyed && d.visible && w.switchUsable(d) && !d.s.open);
    const items = [...w.byClass.entries()].filter(([c]) => ['Ammo Box', 'Health Bonus Item', 'Quest Item Pickup', 'Map Pack', 'Family Picture', 'Map Item', 'Key', 'Item', 'Flashlight'].includes(c)).flatMap(([, l]) => l).filter((d) => !d.destroyed && d.visible && !d.s.taken);
    const hitD = new Map(), hitS = new Map(), hitI = new Map();
    const h0 = floorAt(p.x, p.y, p.z) ?? p.y;
    const seen = new Set([`0,0,${Math.round(h0 * 2)}`]);
    const q = [[0, 0, h0, 0]];
    let n = 0, head = 0;
    const box = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
    while (head < q.length && n < maxN) {
      const [i, k, h, g] = q[head++];
      n++;
      const x = p.x + i * STEP, z = p.z + k * STEP;
      box.min = [Math.min(box.min[0], x), Math.min(box.min[1], h), Math.min(box.min[2], z)];
      box.max = [Math.max(box.max[0], x), Math.max(box.max[1], h), Math.max(box.max[2], z)];
      const pt = [x, h + 0.9, z];
      for (const d of dets) if (!hitD.has(d.uid) && Math.abs(d.box.c[1] - pt[1]) < 6 && inBoxL(d.box, pt)) hitD.set(d.uid, [x, h, z, g]);
      if (n % 3 === 0) {
        for (const d of sws) if (!hitS.has(d.uid) && Math.hypot(d.pos[0] - x, d.pos[2] - z) < 1.6 && Math.abs(d.pos[1] - h) < 2) hitS.set(d.uid, [x, h, z, g]);
        for (const d of items) if (!hitI.has(d.uid) && Math.hypot(d.pos[0] - x, d.pos[2] - z) < 1.5 && Math.abs(d.pos[1] - h) < 2.2) hitI.set(d.uid, [x, h, z, g]);
      }
      for (const [di, dk] of DIRS) {
        if (di && dk) continue;
        const ni = i + di, nk = k + dk;
        const nx = p.x + ni * STEP, nz = p.z + nk * STEP;
        const fh = floorAt(nx, h, nz, 0.9);
        if (fh === null || fh - h > 2 * STEP_UP || h - fh > DROP) continue;
        if (fh - h > STEP_UP) {
          const mh = floorAt((nx + x) / 2, h, (nz + z) / 2);
          if (mh === null || mh - h > STEP_UP || fh - mh > STEP_UP) continue;
        }
        const key = `${ni},${nk},${Math.round(fh * 2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!free(nx, fh, nz)) continue;
        q.push([ni, nk, fh, g + 1]);
      }
    }
    const fmt = (m) => [...m.entries()].map(([u, v]) => { const e = w.get(u); return { uid: u.toString(16), cls: e.cls, at: v.slice(0, 3).map((a) => +a.toFixed(1)), steps: v[3], links: e.e.links.map((l) => (w.get(l)?.cls ?? '?').slice(0, 14) + '#' + l.toString(16)).join(' ') }; });
    reach.last = q.map(([i, k, h]) => [+(p.x + i * STEP).toFixed(1), +h.toFixed(1), +(p.z + k * STEP).toFixed(1)]);
    return { cells: n, done: head >= q.length, box: { min: box.min.map((v) => +v.toFixed(1)), max: box.max.map((v) => +v.toFixed(1)) }, detectors: fmt(hitD), switches: fmt(hitS), items: fmt(hitI) };
  }
  function inBoxL(b, p) {
    const d = [p[0] - b.c[0], p[1] - b.c[1], p[2] - b.c[2]];
    for (let a = 0; a < 3; a++) { const t = d[0] * b.ax[a][0] + d[1] * b.ax[a][1] + d[2] * b.ax[a][2]; if (Math.abs(t) > b.h[a] + 0.3) return false; }
    return true;
  }
  // --- frame counter, message log, played sequences, checkpoints -------------------------
  const frames = old?.frames ?? [];
  if (!old) __view.onFrame(() => { const t = performance.now(); frames.push(t); while (frames.length && t - frames[0] > 2000) frames.shift(); });
  const w0 = __world.world;
  const seen = [];
  const played = new Set();
  const last = new Map();
  // Messages to / from the objects that gate the level exits (the harness copies them into the
  // step notes): 1b's arena end (7ed4 / 7ed5 / 7ed8 -> 80a5 -> 8ba4 / 8c03 -> 80a6, 7ed2), 1c's
  // exit (Waypoint 7b8c -> Relay 808c -> Level Transition 7813; 80b2 / 7edf disable it).
  const WATCH = new Set([0x5c1e, 0x7abf, 0x7b09, 0x8b99, 0x8b9a, 0x8c2c, 0x80a9, 0x7f6c, 0x7f6e, 0x7ed5, 0x7ed8, 0x80a5, 0x8ba4, 0x8ba5, 0x8c03, 0x8b9b, 0x80a6, 0x7ed2, 0x7813, 0x808c, 0x80b2, 0x7edf, 0x7ede]);
  const trace = (window.__ptTrace ??= []);
  // Companions (1a guard 609e, 1c inmate 7569): behaviour / state changes and shots go into the
  // same trace.
  if (!window.__ptActorWatch) {
    window.__ptActorWatch = true;
    const lastSt = new Map();
    __view.onFrame(() => {
      const M = window.__actors?.manager;
      if (!M) return;
      for (const a of M.actors) {
        const u = a.entity?.uid;
        if (u !== 0x609e && u !== 0x7569) continue;
        const k = `${a.behavior?.cls ?? '-'}#${a.behavior?.uid?.toString(16) ?? ''} ${a.state}`;
        if (lastSt.get(u) === k) continue;
        lastSt.set(u, k);
        const q = a.motor.position;
        window.__ptTrace.push(`${(window.__world?.world.time ?? 0).toFixed(1)} ${u.toString(16)} ${k} @${q.x.toFixed(1)},${q.z.toFixed(1)}`);
      }
    });
  }
  w0.subscribe('*', (m, f, t) => {
    const k = m + ':' + f + ':' + t, now = w0.time, prev = last.get(k);
    last.set(k, now);
    if (prev !== undefined && now - prev < 2) return;
    if (WATCH.has(f) || WATCH.has(t)) trace.push(`${now.toFixed(1)} ${m} ${f.toString(16)}>${t.toString(16)}`);
    seen.push([+now.toFixed(1), m, f.toString(16), t.toString(16)]);
    if (seen.length > 4000) seen.splice(0, 1000);
  });
  const checkpoints = old?.checkpoints ?? [];
  if (window.__saves && !window.__saves.__ptHooked) {
    const sv = window.__saves, orig = sv.tick.bind(sv);
    let lastCp = sv.checkpoint;
    sv.tick = (dt, blocked) => { orig(dt, blocked); if (sv.checkpoint !== lastCp) { lastCp = sv.checkpoint; if (lastCp) checkpoints.push({ at: Date.now(), level: lastCp.levelName, t: +(window.__world?.world.time ?? 0).toFixed(1) }); } };
    sv.__ptHooked = true;
  }
  function metrics() {
    const now = performance.now();
    const n = frames.filter((t) => now - t <= 1000).length;
    const info = __view.renderer.info.render;
    const a = window.__audio;
    const buses = {};
    for (const v of a?.voices ?? []) buses[v.bus] = (buses[v.bus] ?? 0) + 1;
    const emitters = [...(a?.emitters ?? [])].filter((e) => e.handle?.playing).length;
    // Ambience: Ambient Sound zone beds (fx) + looping level sound emitters in earshot + Flying
    // Sounds switched on (the 1a storm / prison one-shots, turned on and off by Ambient Sound
    // zones). Most chapter-1 zones carry no bed (only reverb and messages), so 0 is often right.
    const zones = window.__fx?.zones;
    const flying = (window.__fx?.flying?.state?.() ?? []).filter((f) => f.on && !f.dead).map((f) => f.uid);
    const zoneLoops = zones?.playing?.().length ?? 0;
    const ambience = zoneLoops + emitters + flying.length;
    return { fps: n, draws: info.drawCalls, tris: Math.round(info.triangles), audio: a?.context?.state, buses, emitters, zoneLoops, flying, ambience, ambienceZone: zones?.currentUid?.toString(16) ?? null, music: window.__music ? { current: window.__music.current?.toString(16) ?? null, playing: !!window.__music.playing } : null };
  }
  // Actors near the player: floating / sunk (feet vs the ground under them) and stuck movers.
  const track = old?.track ?? new Map();
  /**
   * The highest walkable surface under a feet point: rays at it and 1.5 cm around it (physics.ts
   * centreGround), with the mover's layers (`layers`: movers pass Decorations, 9's fog quads).
   */
  function groundUnder(q, layers) {
    let best = null;
    const c = col(), L = c.queryLayers;
    if (layers !== undefined) c.queryLayers = layers;
    try {
      for (const [dx, dz] of [[0, 0], [0.015, 0], [-0.015, 0], [0, 0.015], [0, -0.015]]) {
        const h = c.raycast(q.x + dx, q.y + 0.6, q.z + dz, 0, -1, 0, 6.6);
        if (h && h.normal[1] > 0.5 && (!best || h.point[1] > best.height)) best = { height: h.point[1], drop: h.distance };
      }
    } finally {
      c.queryLayers = L;
    }
    return best;
  }
  function sanity(range = 30) {
    const p = P(), out = { checked: 0, floating: [], sinking: [], stuck: [] };
    const now = performance.now();
    for (const a of __actors.manager.actors) {
      // A body a sequence holds goes where its keys put it (3a's Hermes 429b, "Hermes" #42, flies
      // through the burnt walkway's floor): not the AI's doing.
      if (a.health <= 0 || a.state === 'dead' || !a.ch.root.visible || a.dormantHidden || a.ceiling || a.scripted) continue;
      // Ambient Creatures are moved by the director along their waypoints (6a's birds fly up into
      // the trees and vanish at the last one): not the AI's floating or sinking.
      if (a.entity?.className === 'Ambient Creature') continue;
      // A crawler in a ceiling / wall transit or a leap (its special's `reactGate` closed) goes
      // where its clips put it: 4a's wall CartWheeler 82d5 read "floating +3.96 / +5.99" at 4a.wake.
      if (a.reactGate && !a.reactGate()) continue;
      const q = a.motor.position;
      if (Math.hypot(q.x - p.x, q.z - p.z) > range) continue;
      out.checked++;
      // Still at the authored placement (props, dormant NPCs): the data's height, not the port's.
      const pl = a.entity?.position;
      if (pl && Math.hypot(pl[0] / 2048 - q.x, pl[1] / 2048 - q.y, pl[2] / 2048 - q.z) < 0.05) continue;
      // An NPC motor stands on the ground under its feet point (the original's rule, docs/
      // game-logic.md §14.9): measured the same way, not with a 15 cm sphere that also touches the
      // rim of a step beside the feet.
      const g = a.motor.cfg.groundProbe === 'centre' ? groundUnder(q, a.motor.layers) : col().groundQuery(q.x, q.y + 0.6, q.z, 0.15, 6);
      const tag = (a.entity?.uid ?? a.id).toString(16) + ' ' + (a.entity?.className ?? '') + ' ' + a.state;
      if (g && a.state !== 'fall' && q.y - g.height > 0.6) out.floating.push(tag + ' +' + (q.y - g.height).toFixed(2));
      // A probe that starts inside geometry (an actor lying under a bunk) reports a 0 drop: not sunk.
      if (g && g.drop > 0.05 && g.height - q.y > 0.3) out.sinking.push(tag + ' -' + (g.height - q.y).toFixed(2));
      const k = a.id, t = track.get(k);
      const moving = a.state === 'move' || a.state === 'chase';
      if (!t || !moving || Math.hypot(q.x - t.x, q.z - t.z) > 0.5) track.set(k, { x: q.x, z: q.z, at: now });
      else if (now - t.at > 8000) out.stuck.push(tag + ' ' + ((now - t.at) / 1000).toFixed(0) + 's');
    }
    return out;
  }
  // One swing: the weapon (services.weapons.fire), or the creature's combo while transformed
  // (the mouse paths need pointer lock, which headless Chrome has not got).
  function allyInFront(range) {
    const p = P();
    const fx = -Math.sin(__player.yaw), fz = -Math.cos(__player.yaw);
    // A gun in hand: only an ally on the line of fire counts (2 Cellblocks: the inmate follows
    // within 2 m and stood at the player's shoulder while he shot a barricade).
    const wp = window.__weapons;
    const ranged = !!wp && wp.service.def(wp.persist.current)?.kind === 'ranged';
    const cam = __view.camera, o = new V3(), dir = new V3();
    if (ranged) (cam.getWorldPosition(o), cam.getWorldDirection(dir));
    for (const a of __actors.manager.actors) {
      if ((a.hostile && !isCompanion(a)) || a.health <= 0 || a.state === 'dead' || !a.ch.root.visible) continue;
      if (a.target?.player || a.grudge?.player) continue;
      // Not a character: a projector (an Animating Static given hit points, specials/projector.ts)
      // is what the player shoots at (5b), never someone to spare.
      if (a.kind.decor || a.profile?.team === 'projector' || a.entity?.className === 'Animating Static') continue;
      // 10's Black Ones are not hostile characters (the special drives them): the boss itself,
      // not someone to spare (the boss step held its fire at the holder for minutes).
      if (a.entity?.className === 'Black One') continue;
      const q = a.motor.position;
      if (ranged) {
        // Closest approach of the view ray to the ally's body axis (feet + 0.3 .. + 1.8 m).
        for (const up of [0.4, 1.0, 1.6]) {
          const vx = q.x - o.x, vy = q.y + up - o.y, vz = q.z - o.z;
          const t = vx * dir.x + vy * dir.y + vz * dir.z;
          if (t <= 0 || t > 30) continue;
          // (Widening with distance: the shotgun's pellets spread; 9's guard bc9 took three.)
          if (Math.hypot(vx - dir.x * t, vy - dir.y * t, vz - dir.z * t) < 0.55 + 0.09 * t) return true;
        }
        continue;
      }
      const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
      if (d < range && Math.abs(q.y - p.y) < 2 && (d < 0.8 || (dx * fx + dz * fz) / d > 0.5)) return true;
    }
    return false;
  }
  // A gun with rounds and a clear line from the eye to the creature's chest within 25 m: shoot
  // from where the player stands (a gunner in a nest the planner cannot reach, 2 Cellblocks 7f4).
  // Festers' armour zeroes bullets but on the weak spot a clip opens (docs/game-logic.md
  // §15.7.3): the run fights them with the blade (6a / 6b), as the bullets do nothing.
  // `__ptSaveRounds` (a step's `saveRounds`): the rounds are kept for what only a gun reaches (10's
  // Black One hearts), so the fights before it take the blade, as a player saving them would;
  // a creature below `__ptFloor` (in the sea off 10's dock: no blade reaches it) is still shot.
  const inSea = (a) => typeof window.__ptFloor === 'number' && !!a && a.motor.position.y < window.__ptFloor;
  const bladeOnly = (a) => a?.entity?.className === 'Fester' || (!!window.__ptSaveRounds && !inSea(a));
  function canShoot(id) {
    const wp = window.__weapons;
    if (!wp || !wp.service.weapons.some((x) => x.kind === 'ranged' && x.clip + x.reserve > 0)) return false;
    const a = __actors.manager.actors.find((x) => x.id === id);
    if (!a || bladeOnly(a)) return false;
    // A Burrower takes shots only while it is up (striking or hit): rounds are not spent on it underground.
    if (a.entity?.className === 'Burrower' && !['attack', 'hurt'].includes(a.state)) return false;
    const e = __player.eyePosition(), q = a.motor.position;
    const dx = q.x - e.x, dy = q.y + 1.2 - e.y, dz = q.z - e.z, d = Math.hypot(dx, dy, dz);
    if (d > 25) return false;
    const h = __view.collision.raycast(e.x, e.y, e.z, dx / d, dy / d, dz / d, d);
    return !h || h.distance > d - 0.6;
  }
  function attack(id) {
    const ins = window.__insanity;
    if (ins?.model && ins.model.form !== 'human') return ins.model.form === 'creature' && !!ins.body?.attack(__player.onGround ? 'combo' : 'jump');
    const wp = window.__weapons;
    if (!wp) return false;
    // Held by a creature: the run's struggle reflex presses the buttons (playthrough.mjs).
    if (__player.attackOverride) return false;
    // Hold the swing / shot while an ally (the escort guard, the 1c inmate) stands in front
    // within 3 m: a hit turns him against the player.
    if (allyInFront(3)) return false;
    // A gun with rounds (in the clip or to load) over the shiv, as a player picks one (the
    // number keys need pointer lock): the last one in the list (the run picks guns up in order).
    const guns = wp.service.weapons.filter((x) => x.kind === 'ranged' && x.clip + x.reserve > 0);
    const cur = wp.persist.current;
    if (id !== undefined && bladeOnly(__actors.manager.actors.find((x) => x.id === id))) {
      // Saving rounds: the heaviest blade carried (the Fire Axe over the shiv).
      const blade = window.__ptSaveRounds && wp.service.weapons.some((x) => x.id === '4:240') ? '4:240' : '4:79';
      if (wp.service.def(cur)?.kind === 'ranged' || (window.__ptSaveRounds && cur !== blade)) wp.service.equip(blade);
      return wp.service.fire();
    }
    if (guns.length && wp.service.def(cur)?.kind !== 'ranged') wp.service.equip(guns.at(-1).id);
    if (wp.service.fire()) return true;
    // An empty gun in hand (no reload left): back to the shiv.
    const now = wp.service.weapons.find((x) => x.id === wp.persist.current);
    if (now && now.kind === 'ranged' && now.clip + now.reserve <= 0) wp.service.equip('4:79');
    return false;
  }
  // Is an actor (level uid) drawn on screen now: shown, not culled, its body (the centre of its
  // skeleton, which follows clips that carry the body away from the origin) inside the view?
  function onScreen(uid) {
    const a = __actors.manager.actors.find((x) => x.entity?.uid === uid);
    if (!a || !a.ch.root.visible || !a.ch.mesh.visible || a.dormantHidden) return null;
    const c = new V3();
    const bones = a.ch.skeleton.bones;
    for (const b of bones) { b.updateWorldMatrix(true, false); c.x += b.matrixWorld.elements[12]; c.y += b.matrixWorld.elements[13]; c.z += b.matrixWorld.elements[14]; }
    c.multiplyScalar(1 / Math.max(1, bones.length));
    const cam = __view.camera;
    cam.updateMatrixWorld();
    const local = c.clone().applyMatrix4(cam.matrixWorldInverse);
    const ndc = c.clone().project(cam);
    if (local.z >= 0 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
    return { x: +ndc.x.toFixed(2), y: +ndc.y.toFixed(2), d: +c.distanceTo(cam.getWorldPosition(new V3())).toFixed(1), body: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)] };
  }
  // A pickup as the player sees it: its mesh in the scene and shown, its centre on screen, and
  // the brightest of its vertex colours (load-time lighting; 0 = drawn black but for the lamps
  // and the flashlight per frame: 1a's dropped revolver before its fix).
  function itemView(uid) {
    const d = __world.dyn.objects.get(uid);
    if (!d) return { built: false };
    let o = d.root;
    while (o.parent) o = o.parent;
    let lit = 0, shown = d.root.visible && d.visible, baked = false;
    const c = new V3();
    d.pivot.traverse((m) => {
      if (!m.isMesh) return;
      shown = shown && m.visible;
      baked = baked || !!m.userData.baked;
      const a = m.geometry.attributes.color?.array ?? [];
      for (let i = 0; i < a.length; i += 4) lit = Math.max(lit, a[i], a[i + 1], a[i + 2]);
    });
    d.root.updateWorldMatrix(true, true);
    c.setFromMatrixPosition(d.root.matrixWorld);
    const cam = __view.camera;
    cam.updateMatrixWorld();
    const ndc = c.clone().project(cam);
    const front = c.clone().applyMatrix4(cam.matrixWorldInverse).z < 0;
    return { built: true, inScene: o === __view.scene, shown, baked, lit: +lit.toFixed(3), onScreen: front && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1, prompt: __world.pickTarget()?.w?.uid === uid };
  }
  window.__pt = { lineTo, lineStand, isCompanion, canShoot, allyDmg, allyInFront, watchScene, sceneWatch, itemView, onScreen, trace, attack, world: w0, frames, seen, played, checkpoints, track, metrics, sanity, msgs: (n = 30) => seen.slice(-n).map((x) => x.join(' ')).join('; '), blockingDoor, openableDoors, withDoorsOpen, reach, dmg, engage, standFor, center, useAim, plan, go, ap, aimAt, state, hostiles, floorAt, free, walkable };
  return true;
})();
