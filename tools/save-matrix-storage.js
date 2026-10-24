// Page side of tools/save-matrix.mjs --storage: the save store's backends and failure cases, in a
// running level (the saves are real captures). Not part of the app bundle. Returns
// { check: { ok, ... } }. Uses the app's own modules through the dev server: the store classes
// (src/game/save/store.ts) and, for "another tab" / "blocked storage", fresh copies of them
// imported in same-origin iframes (a separate realm: its own module instances, like a tab).
(async () => {
  const out = {};
  const store = await import('/src/game/save/store.ts');
  const types = await import('/src/game/save/types.ts');
  const S = window.__saves;
  const base = S.capture('manual', 'st-base');
  const copy = (id, extra = {}) => ({ ...JSON.parse(JSON.stringify(base)), id, createdAt: Date.now(), ...extra });
  const stable = (v) => types.stableJson(v);
  const run = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { ok: false, error: String(e?.stack ?? e).slice(0, 300) };
    }
  };
  const roundTrip = async (st) => {
    const d = copy(`st-rt-${st.kind}`);
    const put = await st.put(d);
    const back = await st.get(d.id);
    const listed = (await st.list()).some((s) => s.id === d.id && !s.damaged);
    const del = await st.delete(d.id);
    const gone = !(await st.list()).some((s) => s.id === d.id);
    return { ok: put && !!back && stable(back) === stable(d) && listed && del && gone, put, same: !!back && stable(back) === stable(d), listed, del, gone, bytes: JSON.stringify(d).length };
  };

  // 1. The three backends.
  const idb = await store.IndexedDbStore.open();
  await run('indexeddb', () => (idb ? roundTrip(idb) : { ok: false, error: 'IndexedDB did not open' }));
  await run('localStorage', () => roundTrip(new store.LocalStorageStore()));
  await run('memory', () => roundTrip(new store.MemoryStore()));
  await run('app store', async () => ({ ok: S.store.kind === 'indexeddb', kind: S.store.kind }));

  // 2. Quota exceeded. localStorage: really filled (5-10 MB per origin), then a save written.
  await run('quota localStorage', async () => {
    const ls = new store.LocalStorageStore();
    // Filled to the last kilobyte: blocks of 256 K characters, then 16 K, then 1 K.
    let n = 0, chars = 0;
    for (const size of [256 * 1024, 16 * 1024, 1024]) {
      const junk = 'x'.repeat(size);
      try {
        for (let k = 0; k < 400; k++, n++) {
          localStorage.setItem(`st-junk-${n}`, junk);
          chars += size;
        }
      } catch {}
    }
    const ok = await ls.put(copy('st-quota'));
    const err = ls.lastError;
    for (let i = 0; i <= n; i++) localStorage.removeItem(`st-junk-${i}`);
    const after = await ls.put(copy('st-quota'));
    await ls.delete('st-quota');
    return { ok: !ok && err === 'quota' && after && ls.lastError === undefined, filledMB: +((chars * 2) / 1e6).toFixed(1), refused: !ok, lastError: err, writesAfterCleanup: after };
  });
  // IndexedDB: the browser's quota is far larger than a test can fill; its QuotaExceededError
  // (thrown by put, or aborting the transaction) is simulated on the object store.
  await run('quota indexeddb', async () => {
    const proto = IDBObjectStore.prototype;
    const real = proto.put;
    proto.put = function () {
      throw new DOMException('simulated', 'QuotaExceededError');
    };
    let ok, err;
    try {
      ok = await idb.put(copy('st-quota-idb'));
      err = idb.lastError;
    } finally {
      proto.put = real;
    }
    // The manager's Save Game path: null, and the reason for the menu's message.
    proto.put = function () {
      throw new DOMException('simulated', 'QuotaExceededError');
    };
    let manual, reason;
    try {
      const prev = S.store;
      S.store = idb;
      manual = await S.saveManual('st-quota-manual').catch((e) => String(e));
      reason = S.lastError;
      S.store = prev;
    } finally {
      proto.put = real;
    }
    const after = await idb.put(copy('st-quota-idb'));
    await idb.delete('st-quota-idb');
    return { ok: ok === false && err === 'quota' && manual === null && reason === 'quota' && after, refused: ok === false, lastError: err, saveManual: manual === null ? null : 'stored?', reason, writesAfter: after };
  });

  // 3. Corrupted entries: not JSON (localStorage), not a save (IndexedDB raw record), a save with
  // garbage provider data (loads, providers skip what they cannot read).
  await run('corrupt entries', async () => {
    localStorage.setItem('suffering.save.st-bad-ls', '{not json');
    await new Promise((res, rej) => {
      const r = indexedDB.open('suffering-saves', 1);
      r.onsuccess = () => {
        const tx = r.result.transaction('saves', 'readwrite');
        tx.objectStore('saves').put({ id: 'st-bad-idb', levelPath: 42, garbage: true });
        tx.oncomplete = () => (r.result.close(), res());
        tx.onerror = () => rej(tx.error);
      };
      r.onerror = () => rej(r.error);
    });
    const ls = new store.LocalStorageStore();
    const lsList = await ls.list();
    const idbList = await idb.list();
    const lsDamaged = lsList.find((s) => s.id === 'st-bad-ls')?.damaged === true;
    const idbDamaged = idbList.find((s) => s.id === 'st-bad-idb')?.damaged === true;
    const gets = [await ls.get('st-bad-ls'), await idb.get('st-bad-idb')];
    const dels = [await ls.delete('st-bad-ls'), await idb.delete('st-bad-idb')];
    const gone = !(await ls.list()).some((s) => s.id === 'st-bad-ls') && !(await idb.list()).some((s) => s.id === 'st-bad-idb');
    return { ok: lsDamaged && idbDamaged && gets.every((g) => g === null) && dels.every(Boolean) && gone, lsDamaged, idbDamaged, getsNull: gets.every((g) => g === null), deleted: dels, gone };
  });
  await run('garbage provider data', async () => {
    const d = copy('st-garbage');
    for (const k of Object.keys(d.game)) d.game[k] = 'garbage';
    const key = Object.keys(d.levels)[0];
    for (const k of Object.keys(d.levels[key])) d.levels[key][k] = k === 'world' ? { ents: 'x', rt: 7 } : [1, 2, 3];
    const errs = [];
    const orig = console.error;
    console.error = (...a) => (errs.push(a.map(String).join(' ').slice(0, 120)), orig.apply(console, a));
    let restored;
    try {
      restored = await S.host.restore(d);
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      console.error = orig;
    }
    const alive = (window.__actors?.combat?.health ?? 0) > 0 && !!window.__world?.world;
    // Put the level back as it was (the base capture).
    await S.host.restore(base);
    await new Promise((r) => setTimeout(r, 2000));
    return { ok: !!restored && alive, restored, levelRuns: alive, providerErrors: errs.length, sample: errs.slice(0, 3) };
  });

  // 4. Versions (migrateSave): an old record without the later fields, a version-0 record, a
  // newer version (refused, listed as damaged), and the rsg import marker.
  await run('versions', async () => {
    const old = { version: 1, id: 'st-old', levelPath: base.levelPath, createdAt: 1 };
    const m = types.migrateSave(old);
    const v0 = types.migrateSave({ ...base, version: 0, id: 'st-v0' });
    const future = types.migrateSave({ ...base, version: types.SAVE_VERSION + 1 });
    const noVersion = types.migrateSave({ ...base, version: undefined });
    await idb.put({ ...base, id: 'st-future', version: types.SAVE_VERSION + 1 });
    const listed = (await idb.list()).find((s) => s.id === 'st-future');
    await idb.delete('st-future');
    return { ok: !!m && m.kind === 'manual' && m.title === types.levelStem(base.levelPath) && !!v0 && future === null && noVersion === null && listed?.damaged === true, oldMigrated: !!m && { kind: m.kind, title: m.title, game: m.game }, v0: !!v0, futureRefused: future === null, noVersionRefused: noVersion === null, futureListedDamaged: listed?.damaged };
  });

  // 5. Many saves: 60 real-size saves in IndexedDB; list / get / delete times.
  await run('many saves', async () => {
    const N = 60;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await idb.put(copy(`st-many-${i}`, { createdAt: Date.now() + i }));
    const tPut = performance.now() - t0;
    const t1 = performance.now();
    const list = await idb.list();
    const tList = performance.now() - t1;
    const t2 = performance.now();
    await idb.get('st-many-30');
    const tGet = performance.now() - t2;
    const newestFirst = list.filter((s) => s.id.startsWith('st-many-')).map((s) => s.id)[0] === `st-many-${N - 1}`;
    const t3 = performance.now();
    for (let i = 0; i < N; i++) await idb.delete(`st-many-${i}`);
    const tDel = performance.now() - t3;
    const left = (await idb.list()).filter((s) => s.id.startsWith('st-many-')).length;
    return { ok: newestFirst && left === 0 && tList < 3000, n: N, bytesEach: JSON.stringify(base).length, putMs: Math.round(tPut), listMs: Math.round(tList), getMs: Math.round(tGet), deleteMs: Math.round(tDel), newestFirst, left };
  });

  // 6. Delete: through the manager (the menu's path), a missing id, the in-memory checkpoint id.
  await run('delete', async () => {
    await S.store.put(copy('st-del'));
    const a = await S.delete('st-del');
    const gone = !(await S.list()).some((s) => s.id === 'st-del');
    const missing = await S.delete('st-never-there');
    return { ok: a && gone && missing, deleted: a, gone, missingIdOk: missing };
  });

  // Fresh realms: a same-origin iframe with its own module instances (a tab of its own).
  const realm = async (block) => {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.body.append(f);
    const w = f.contentWindow;
    if (block) {
      // A private window / blocked site data: the storage getters throw (Chromium's behaviour
      // with cookies blocked), IndexedDB open would fail too.
      for (const k of ['indexedDB', 'localStorage', 'sessionStorage']) Object.defineProperty(w, k, { get() { throw new DOMException('blocked', 'SecurityError'); } });
    }
    const st = await w.eval(`import('/src/game/save/store.ts')`);
    return { f, w, st };
  };

  // 7. Blocked storage (private window): memory store, saves work for the session, settings and
  // profile modules load without throwing.
  await run('blocked storage', async () => {
    const r = await realm(true);
    const s = await r.st.openSaveStore();
    const rt = await roundTrip(s);
    let settingsOk = true, profileOk = true;
    try {
      const m = await r.w.eval(`import('/src/app/menu/settings.ts')`);
      m.loadSettings();
      m.saveSettings(m.loadSettings());
    } catch (e) {
      settingsOk = String(e).slice(0, 120);
    }
    try {
      const m = await r.w.eval(`import('/src/app/menu/profile.ts')`);
      m.profile.unlockPages(['5:1']);
    } catch (e) {
      profileOk = String(e).slice(0, 120);
    }
    r.f.remove();
    return { ok: s.kind === 'memory' && rt.ok && settingsOk === true && profileOk === true, kind: s.kind, roundTrip: rt.ok, settingsOk, profileOk };
  });

  // 8. Two tabs: the other tab sees this tab's saves and hears about them (BroadcastChannel); the
  // other tab deletes the database (as "clear site data" in it would): this tab's connection
  // closes (versionchange) and the next write opens it again.
  await run('two tabs', async () => {
    const r = await realm(false);
    const other = await r.st.IndexedDbStore.open();
    let heard = 0;
    const ch = r.st.storeChannel(() => heard++);
    const d = copy('st-tab');
    await S.importSaves([d]);
    await new Promise((res) => setTimeout(res, 300));
    const seen = (await other.list()).find((s) => s.id.startsWith('st-tab'));
    const otherGet = seen ? await other.get(seen.id) : null;
    // The other tab writes; this tab reads it.
    await other.put(copy('st-tab-2'));
    const mine = await S.get('st-tab-2');
    // Same-millisecond saves get distinct ids (the random part).
    const ids = new Set([0, 1, 2, 3, 4, 5].map(() => `save-${Date.now().toString(36)}-0${Math.floor(Math.random() * 1296).toString(36)}`));
    // The other tab deletes the database.
    const deleted = await new Promise((res) => {
      const q = r.w.indexedDB.deleteDatabase('suffering-saves');
      q.onsuccess = () => res('deleted');
      q.onerror = () => res('error');
      q.onblocked = () => res('blocked');
    });
    const putAfter = await idb.put(copy('st-after-delete'));
    const appPutAfter = await S.store.put(copy('st-after-delete-app'));
    const back = !!(await S.store.get('st-after-delete-app'));
    await idb.delete('st-after-delete');
    await S.store.delete('st-after-delete-app');
    ch.close();
    r.f.remove();
    return { ok: !!seen && !!otherGet && !!mine && heard > 0 && deleted === 'deleted' && putAfter && appPutAfter && back, otherSees: !!seen, otherReads: !!otherGet, readsOthers: !!mine, notified: heard, dbDelete: deleted, reopenedWrite: putAfter && appPutAfter && back, distinctIds: ids.size };
  });
  for (const s of await S.list()) if (s.id.startsWith('st-')) await S.delete(s.id);
  return out;
})()
