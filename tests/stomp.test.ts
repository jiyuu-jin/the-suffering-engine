// STOMP sequence (.qdu) decoding against a local game install (skipped without one).
// Structural checks only: exact byte coverage, key ordering and value ranges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, filesWithExt, readSrsc, skip } from './helpers';
import { decodeStompSequence, keyIndexAt, QDU_SEQUENCE, sampleTrack } from '../src/game/world/stomp';
import { clipCoverage, guessClipLabel, readAnimation } from '../src/formats/animation';
import { readDbId } from '../src/formats/model';
import { instanceRotation, parseLevelObjects } from '../src/formats/level';
import { classByHash, indexEntities, parseEntities, type EntityPackage } from '../src/formats/entities';
import { readSkinnedModel } from '../src/formats/skeleton';
import { BehaviorLibrary, CHAR, templateList, templateProp } from '../src/game/actors/behaviors';

test('every STOMP sequence decodes completely with ordered keys', { skip }, () => {
  let sequences = 0, keys = 0;
  for (const path of filesWithExt('.qdu')) {
    const file = readSrsc(path);
    for (const e of file.entries) {
      if (e.type !== QDU_SEQUENCE) continue;
      const seq = decodeStompSequence(file.data(e), e.id);
      sequences++;
      assert.equal(seq.byteLength, e.size, `${path}#${e.id}: decoded ${seq.byteLength} of ${e.size} bytes`);
      for (const t of seq.tracks) {
        const all = [...t.transforms, ...t.anims, ...t.sounds, ...t.attaches, ...t.controls, ...t.visibility, ...t.messages, ...t.cameras];
        keys += all.length;
        for (const list of [t.transforms, t.anims, t.sounds, t.messages, t.cameras]) {
          for (let i = 1; i < list.length; i++) assert.ok(list[i].time >= list[i - 1].time, `${path}#${e.id} "${t.name}": keys out of order`);
        }
        for (const k of t.transforms) {
          assert.ok(Math.abs(Math.hypot(...k.quat) - 1) < 1e-3, `${path}#${e.id} "${t.name}": non-unit quaternion`);
          assert.ok(k.position.every((x) => Number.isFinite(x) && Math.abs(x) < 1e10)) // a few keys park objects far away;
        }
        for (const k of t.cameras) assert.ok(k.fov >= 0 && k.fov < 180 && k.timeScale > 0);
        for (const k of t.sounds) assert.ok(k.volume >= 0 && k.volume <= 1 && k.sound.pkg > 0);
        for (const k of t.anims) assert.ok(k.clip.pkg > 0 && k.speed >= 0);
        if (t.transforms.length) assert.ok(sampleTrack(t, seq.duration));
      }
    }
  }
  assert.ok(sequences > 150, `expected 150+ sequences, found ${sequences}`);
  assert.ok(keys > 10000);
});

// Transform keys store the inverse of the object rotation; the decoder conjugates it. Two
// independent checks of the convention:
//   * characters playing a forward walk / run clip travel along their facing (model -Z);
//   * objects keyed exactly at their level placement get the placement rotation.
test('STOMP transform keys decode to the object rotation (facing = travel direction)', { skip }, () => {
  const rot = (q: readonly number[], v: number[]) => {
    const [x, y, z, w] = q;
    const cx = y * v[2] - z * v[1], cy = z * v[0] - x * v[2], cz = x * v[1] - y * v[0];
    const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx;
    return [v[0] + 2 * (w * cx + dx), v[1] + 2 * (w * cy + dy), v[2] + 2 * (w * cz + dz)];
  };
  const adu = new Map<number, ReturnType<typeof readSrsc>>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    const a = db.replace(/\.db$/i, '.adu');
    if (id !== undefined && existsSync(join(DATA_ROOT, a))) adu.set(id, readSrsc(a));
  }
  const labels = new Map<string, string>();
  const label = (pkg: number, id: number) => {
    const k = `${pkg}:${id}`;
    if (!labels.has(k)) {
      const f = adu.get(pkg);
      const c = f && readAnimation(f, id);
      labels.set(k, c ? guessClipLabel(c) : '');
    }
    return labels.get(k)!;
  };
  let walks = 0, agree = 0;
  for (const path of filesWithExt('.qdu')) {
    const file = readSrsc(path);
    for (const e of file.entries) {
      if (e.type !== QDU_SEQUENCE) continue;
      for (const t of decodeStompSequence(file.data(e), e.id).tracks) {
        const k = t.transforms, anims = t.anims.filter((a) => a.channel === 0);
        for (let i = 0; i + 1 < k.length; i++) {
          const a = k[i], b = k[i + 1], dt = b.time - a.time;
          if (dt < 0.2 || b.flags & 0x100 || !(b.flags & 0x30)) continue;
          const dx = b.position[0] - a.position[0], dz = b.position[2] - a.position[2];
          const dist = Math.hypot(dx, dz);
          if (dist < 0.5 * 2048) continue;
          const ai = keyIndexAt(anims, a.time + dt / 2);
          if (ai < 0 || !/^(walk|run)_forward$/.test(label(anims[ai].clip.pkg, anims[ai].clip.id))) continue;
          const fa = rot(a.quat, [0, 0, -1]), fb = rot(b.quat, [0, 0, -1]);
          const fx = fa[0] + fb[0], fz = fa[2] + fb[2];
          walks++;
          if ((fx * dx + fz * dz) / (Math.hypot(fx, fz) * dist) > 0.7) agree++;
        }
      }
    }
  }
  assert.ok(walks > 50, `expected 50+ walking segments, found ${walks}`);
  assert.ok(agree / walks > 0.95, `facing agrees with travel on only ${agree}/${walks} walking segments`);

  // 1a "Goose": Light1 / Floyd / the cell doors are keyed at their placements (one door
  // starts swung open, so count matches rather than requiring all of them).
  const lvl = readSrsc('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl');
  const objs = new Map(parseLevelObjects(lvl).map((o) => [o.uid, o]));
  const q = readSrsc('LEVELS/1 PrisonDeathRow/1 PrisonDeathRow.qdu');
  const goose = q.entries.find((x) => x.type === QDU_SEQUENCE && x.id === 284)!;
  const matches = (quat: readonly number[], R: number[]) =>
    [0, 1, 2].every((c) => {
      const v = rot(quat, [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0]);
      return [0, 1, 2].every((r) => Math.abs(v[r] - R[3 * r + c]) < 0.05);
    });
  let placed = 0, inverseOnly = 0;
  for (const t of decodeStompSequence(q.data(goose), 284).tracks) {
    const o = objs.get(t.uid), k0 = t.transforms[0];
    if (!o || !k0 || Math.hypot(...k0.position.map((v, i) => v - o.position[i])) > 1) continue;
    const R = instanceRotation(o.rotation);
    if (matches(k0.quat, R)) placed++;
    else if (matches([-k0.quat[0], -k0.quat[1], -k0.quat[2], k0.quat[3]], R)) inverseOnly++;
  }
  assert.equal(inverseOnly, 0, 'placement matches the stored (inverse) quaternion instead');
  assert.ok(placed >= 4, `expected 4+ tracks keyed at their placement, found ${placed}`);
});

// 1a "Goose" shows the inmates' corpse doubles and the stabbed inmate through a relay and a
// Visibility Toggler (docs/game-logic.md §11.4 "Corpse doubles"). Their rest poses (lying on
// the bed, corpse poses) and the stabbed inmate's own death clip are level-package clips of
// another animation set; the actors system accepts such a clip for a rig only when every
// track hits a bone and >= 90 % of the bones are animated (actors/kinds.ts fitsRig). Without
// that, the inmate stood alive in front of his bed and died with the generic clip.
test('1a "Goose": characters it reveals have rest / death clips that fit their rig', { skip }, () => {
  const packages = new Map<number, EntityPackage & { adu?: ReturnType<typeof readSrsc>; mdu?: ReturnType<typeof readSrsc> }>();
  for (const db of filesWithExt('.db')) {
    const id = readDbId(readFileSync(join(DATA_ROOT, db), 'latin1'));
    if (id === undefined || packages.has(id)) continue;
    const base = db.slice(0, -3);
    const ld = (ext: string) => (existsSync(join(DATA_ROOT, base + ext)) ? readSrsc(base + ext) : undefined);
    packages.set(id, { id, name: base, odu: ld('.odu'), xdu: ld('.xdu'), qdu: ld('.qdu'), adu: ld('.adu'), mdu: ld('.mdu') } as EntityPackage);
  }
  const ents = parseEntities(readSrsc('LEVELS/1 PrisonDeathRow/1a PrisonDeathRow.lvl'), packages);
  const byUid = indexEntities(ents);
  const B = new BehaviorLibrary(packages, byUid);
  // Message Relay 5f1b ("Turn All Lights On", keyed by Goose) -> Visibility Toggler 7653.
  const toggler = byUid.get(0x7653)!;
  assert.ok(byUid.get(0x5f1b)?.links.includes(0x7653), 'relay 5f1b shows toggler 7653');
  const chars = toggler.links.map((u) => byUid.get(u)!).filter((e) => e?.family === 'Character');
  assert.ok(chars.length >= 4, `expected 4+ characters behind toggler 7653, found ${chars.length}`);
  let checked = 0;
  for (const e of chars) {
    const types = classByHash(e.classHash)?.types ?? [];
    const act = B.fromTemplate(templateProp(e.values, types, CHAR.active));
    const clips = act?.kind === 'death' ? act.clips : act?.kind === 'idle' || act?.kind === 'dormant' ? [act.clip] : [];
    for (const r of templateList(e.values, CHAR.deaths)) {
      const d = B.fromTemplate(r);
      if (d?.kind === 'death') clips.push(...d.clips);
    }
    const skinned = readSkinnedModel(packages, e.modelRef!)!;
    for (const r of clips) {
      assert.ok(r, `${e.uid.toString(16)}: behaviour without a clip`);
      const c = readAnimation(packages.get(r!.pkg)!.adu!, r!.id)!;
      assert.ok(c, `${e.uid.toString(16)}: clip ${r!.pkg}:${r!.id} missing`);
      const fits = c.animSet === skinned.animSet || (c.tracks.length >= skinned.skeleton.bones.length * 0.9 && clipCoverage(c, skinned.skeleton) === 1);
      assert.ok(fits, `${e.uid.toString(16)}: clip ${r!.pkg}:${r!.id} (set ${c.animSet}) does not fit rig set ${skinned.animSet}`);
      checked++;
    }
  }
  // The stabbed inmate: alive, lying on his bed (idle pose), with his own DeathBehavior clip.
  const inmate = byUid.get(0x7652)!;
  const types = classByHash(inmate.classHash)?.types ?? [];
  assert.equal(B.fromTemplate(templateProp(inmate.values, types, CHAR.active))?.kind, 'idle');
  assert.ok(templateList(inmate.values, CHAR.deaths).length > 0, 'instance p72 death behaviour');
  assert.ok(checked >= 5, `expected 5+ clips, checked ${checked}`);
});
