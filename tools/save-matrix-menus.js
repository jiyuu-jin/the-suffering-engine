// Page side of tools/save-matrix.mjs --menus (the menu flow: a New Game through the menus). Not
// part of the app bundle. Phase 'files' checks the Load / Save lists' file rows, the .json
// bundle import, the original game's files (a synthetic .rsg of level 1b and an Unspeakable.cfg
// built in the page with the app's own writers), the Unspeakable.cfg export, and loads the
// imported .rsg save (the start of its level, a new game's state). Returns { check: { ok, ... } }.
(async (phase) => {
  const out = {};
  const F = window.__menu;
  const S = window.__saves;
  const run = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { ok: false, error: String(e?.stack ?? e).slice(0, 400) };
    }
  };
  const waitFor = async (fn, ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      try {
        if (await fn()) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const so = await import('/src/formats/save-original.ts');
  const tr = await import('/src/game/save/transfer.ts');
  const file = (path, bytes, lastModified = Date.now()) => ({ name: path.split('/').pop(), path, lastModified, bytes: async () => bytes });
  const rows = (screen) => (F.model.screens[screen]?.items ?? []).map((it) => ({ text: it.label?.text ?? '', kind: it.action?.kind, tool: !!it.save?.tool, export: !!it.exportAction, disabled: !!it.disabled }));

  if (phase === 'files') {
    await run('menu rows', async () => {
      // A manual save first (the pause menu's Save Game path).
      const d = await S.saveManual();
      await F.refreshSaves();
      const load = rows('loadGameInGame'), sv = rows('saveGame');
      const tools = load.filter((r) => r.tool).map((r) => r.kind);
      const saveTools = sv.filter((r) => r.tool).map((r) => r.kind);
      const exportKey = load.some((r) => r.export);
      return { ok: !!d && ['importSaves', 'importOriginal', 'importOriginal', 'exportSaves'].every((k) => tools.includes(k)) && saveTools.includes('exportOriginalSettings') && exportKey, saved: d?.id, loadTools: tools, saveTools, exportKey };
    });
    await run('bundle import', async () => {
      const all = await S.exportAll();
      const text = JSON.stringify(tr.makeBundle(all));
      const again = await F.importSaveFiles([file('suffering-saves.json', new TextEncoder().encode(text))]);
      // A copy with one save changed: imported under a new id.
      const changed = JSON.parse(text);
      changed.saves[0].playtime += 100;
      const third = await F.importSaveFiles([file('changed.json', new TextEncoder().encode(JSON.stringify(changed)))]);
      const junk = await F.importSaveFiles([file('junk.json', new TextEncoder().encode('{"hello":1}'))]);
      return { ok: again.added === 0 && again.skipped === all.length && third.added === 1 && junk.bad === 1, exported: all.length, reimport: again, changed: third, junk };
    });
    let rsgId;
    await run('original files', async () => {
      const lv = 'Levels\\1 PrisonDeathRow\\1b PrisonDeathRow.lvl';
      const w = 8, h = 6;
      const px = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 2 ? 200 : 40));
      const header = so.writeSaveHeaderPayload({ flag: 1, slot: 2, chapterId: 77, levelPath: lv, name: 'Imported chapter', thumbnail: { width: w, height: h, format: 21, data: px } });
      const body = new so.EngineWriter().u32(0).u32(1234).u32(0).u32(0).f32(0).finish();
      const rsg = so.writeChunks([{ tag: so.CHUNK_HEADER, id: 0, data: header }, { tag: so.CHUNK_BODY, id: 0, data: body }]);
      const folder = Math.floor(Date.UTC(2005, 2, 1) / 1000 + 1).toString(16);
      const cfgIn = { ...so.defaultOriginalSettings(), effectsVolume: 0.3, flags: so.defaultOriginalSettings().flags | so.SettingsFlag.Subtitles | so.SettingsFlag.GameFinished, archives: [0b111, 1], bindings: [{ action: 0x3ea, device: 0, code: 1, lo: -1, hi: 1 }] };
      const cfg = so.writeOriginalSettings(cfgIn);
      const unknown = so.writeChunks([{ tag: so.CHUNK_HEADER, id: 0, data: so.writeSaveHeaderPayload({ flag: 1, slot: 3, chapterId: 0, levelPath: 'Levels\\99 Nowhere\\x.lvl', name: 'x' }) }]);
      const r = await F.importOriginalFiles([file(`Saves/${folder}/1b PrisonDeathRow.rsg`, rsg), file('Unspeakable.cfg', cfg), file(`Saves/${(parseInt(folder, 16) + 5).toString(16)}/x.rsg`, unknown), file('Saves/bad/broken.rsg', new Uint8Array([1, 2, 3]))]);
      const list = await S.list();
      const imp = list.find((s) => s.id === `rsg-${folder}`);
      rsgId = imp?.id;
      const settings = JSON.parse(localStorage.getItem('suffering.settings.v1') ?? '{}');
      const prof = JSON.parse(localStorage.getItem('suffering.profile.v1') ?? '{}');
      return {
        ok: r.added === 1 && r.settings && r.unknown === 1 && r.errors.length === 1 && !!imp && imp.title === 'Imported chapter' && !!imp.thumbnail && imp.createdAt === Date.UTC(2005, 2, 1) && Math.abs(settings.sfx - 0.3) < 1e-6 && settings.subtitles === true && prof.prelude === true && (prof.pages ?? []).length >= 2,
        result: r,
        save: imp && { id: imp.id, title: imp.title, level: imp.levelName, thumb: !!imp.thumbnail, createdAt: new Date(imp.createdAt).toISOString() },
        sfx: settings.sfx,
        subtitles: settings.subtitles,
        prelude: prof.prelude,
        pages: (prof.pages ?? []).length,
      };
    });
    await run('cfg export', async () => {
      const op = await import('/src/app/menu/original-profile.ts');
      const r = await op.buildOriginalProfile(F.settings, F.model.archives, F.host.fs);
      const back = so.parseOriginalSettings(r.bytes);
      return { ok: back.valid && r.base === 'imported' && back.bindings.length === 1 && Math.abs(back.effectsVolume - 0.3) < 1e-6 && !!(back.flags & so.SettingsFlag.GameFinished), base: r.base, bindings: back.bindings.length, valid: back.valid, archives: back.archives };
    });
    await run('cfg export defaults', async () => {
      // Without an imported file: the RFL's default key table from the game data.
      const saved = localStorage.getItem('suffering.original-profile.v1');
      localStorage.removeItem('suffering.original-profile.v1');
      const op = await import('/src/app/menu/original-profile.ts');
      const r = await op.buildOriginalProfile(F.settings, F.model.archives, F.host.fs);
      if (saved) localStorage.setItem('suffering.original-profile.v1', saved);
      const back = so.parseOriginalSettings(r.bytes);
      return { ok: back.valid && r.base === 'defaults' && back.bindings.length > 50, base: r.base, bindings: back.bindings.length };
    });
    await run('load imported rsg', async () => {
      if (!rsgId) return { ok: false, error: 'no imported save' };
      // Something carried that a new game at 1b must not have.
      window.__weapons.service.give('4:84', 1);
      window.__insanity.model.s.reputation = 77;
      const t0 = performance.now();
      await F.loadSave(rsgId, true);
      const ok = await waitFor(() => /1b PrisonDeathRow/.test(window.__world?.world?.opts.levelPath ?? '') && window.__world.world.time > 0.5 && !!window.__actors?.combat, 240_000);
      const inv = [...window.__world.inventory.items.values()].map((i) => `${i.name} ${i.count}`);
      const rep = window.__insanity?.model?.s.reputation;
      const shotgun = [...window.__world.inventory.items.values()].some((i) => i.template?.id === 84 && i.count > 0);
      return { ok: ok && !shotgun && rep === 0 && (window.__actors.combat.health ?? 0) > 0, loaded: ok, seconds: Math.round((performance.now() - t0) / 1000), inventory: inv, reputation: rep, shotgunGone: !shotgun };
    });
    return out;
  }
  if (phase === 'continue') {
    // A fresh page (?skipintro): the main menu's Continue loads the newest save from the store.
    await run('continue after reload', async () => {
      await waitFor(() => !!window.__menu && window.__menu.frontend.currentMode === 'menu', 120_000);
      const newest = await S.newest();
      await F.continueGame(false);
      const ok = await waitFor(() => !!window.__world?.world && window.__world.world.time > 0.5 && !!window.__actors?.combat && F.inGame, 240_000);
      return { ok: ok && !!newest && (window.__world.world.opts.levelPath ?? '') === newest.levelPath, store: S.store.kind, newest: newest && { id: newest.id, level: newest.levelName }, level: window.__world?.world?.opts.levelPath };
    });
    return out;
  }
  return { error: `no phase ${phase}` };
})
