// Reputation / blood skins on Torque and his weapons (rules and data: reputation-skin.ts,
// docs/game-logic.md §13.6).
//
// Every frame the system works out which Blood Texture Set each channel shows (body: Player p66
// by reputation and blood level; first-person arms: p67; the held weapon: its p61 by its own
// blood level) and swaps `material.map` on every instance of the affected models: the player
// body (2:9) and arms (2:138) of services.actors.playerBody, the held weapon models under them
// (services.weapons), the STOMP puppet ("stomp-player-puppet", same model) and any other 2:9 /
// 2:138 mesh in the scene (the creature form's morph-back rig) found by a periodic scan. Nothing
// else is edited: the meshes keep their materials, only the map texture changes (no blending:
// the original swaps whole sets). The creature model (2:124) is never reskinned.
//
// Blood level: Blood Point Generators spawned through the world fx (an observer at the head of
// services.world.fx.spawners; it never consumes the spawn) add blood by distance; it drains at
// p69 / s (not while transformed: the original skips the update in the morph / creature states)
// and is clamped to p68. Weapons: the held weapon receives the same additions (the Player
// forwards them to the items in both hands) and drains at its own p63 [inferred].
//
// State: reputation is services.insanity.reputation (saved by the insanity provider); the blood
// levels are saved here ('repskin', game scope) and carried between levels. New Game resets
// them to 0, so a new game starts on the neutral suite's clean set.
//
// Debug: window.__repskin = { state(), setBlood(n), addBlood(n), refresh(), pendingFill }.
// Service: services.repskin = { blood, maxBlood, addBlood(n), changedBack() } (the insanity
// system calls changedBack() when the morph back to human ends).

import type * as THREE from 'three/webgpu';
import type { GameContext, GameSystem } from '../runtime';
import type { EntityPackageSet, PropValue } from '../../formats/entities';
import { readObjectTemplate } from '../../formats/entities';
import { readModel, type PackageSet, type ResRef } from '../../formats/model';
import { modelTexture } from '../weapons/models';
import { registerSave } from '../save/providers';
import {
  bloodFromGenerator,
  modelSlotTextures,
  readPlayerSkins,
  readWeaponSkin,
  refKey,
  skinFor,
  type SkinChannel,
} from './reputation-skin';

const BODY_MODEL = '2:9';
const ARMS_MODEL = '2:138';

interface Persist {
  blood: number;
  /** Weapon template "pkg:id" -> blood level. */
  weapons: Record<string, number>;
}
const fresh = (): Persist => ({ blood: 0, weapons: {} });
/** Carried between levels like the reputation (module scope outlives a level's systems). */
const carried: Persist = fresh();

interface PlayerBodyLike {
  body: { mesh: THREE.Object3D; root: THREE.Object3D };
  arms?: { mesh: THREE.Object3D; root: THREE.Object3D };
  armsPivot: THREE.Object3D;
}
interface FxLike {
  spawners: ((t: { cls: string; values: unknown[] }, M: THREE.Matrix4, ctx: unknown) => boolean)[];
}

const log = (...a: unknown[]) => console.log('[repskin]', ...a);

export function createReputationSkinSystem(ctx: GameContext): GameSystem {
  const { view } = ctx;
  const pkgs = ctx.loaded.packages as PackageSet | undefined;
  const epk = pkgs as unknown as EntityPackageSet | undefined;
  const skins = epk ? readPlayerSkins(epk) : undefined;
  if (!pkgs || !epk || !skins) return { name: 'repskin (no Player template)' };

  const s = carried;
  const svc = <T>(k: string) => ctx.services[k] as T | undefined;
  const reputation = () => {
    const r = svc<{ reputation?: number }>('insanity')?.reputation;
    return typeof r === 'number' && Number.isFinite(r) ? r : 0;
  };
  const transformed = () => (svc<{ mode?: string }>('insanity')?.mode ?? 'normal') !== 'normal';
  const weaponId = () => svc<{ current?: { id?: string } | null }>('weapons')?.current?.id ?? null;

  // --- Weapon channels and model slot maps (cached). -------------------------------------
  const weaponSkins = new Map<string, { ch: SkinChannel; model?: string } | null>();
  const weaponSkin = (id: string) => {
    if (!weaponSkins.has(id)) {
      const [pkg, n] = id.split(':').map(Number);
      const r: ResRef = { pkg, id: n };
      const ch = readWeaponSkin(epk, r);
      const m = readObjectTemplate(epk, r)?.modelRef;
      weaponSkins.set(id, ch ? { ch, model: m ? refKey(m) : undefined } : null);
    }
    return weaponSkins.get(id) ?? undefined;
  };
  const slotTex = new Map<string, (string | undefined)[]>();
  const slotsOfModel = (key: string) => {
    let v = slotTex.get(key);
    if (!v) {
      const [pkg, id] = key.split(':').map(Number);
      slotTex.set(key, (v = modelSlotTextures(pkgs, { pkg, id })));
    }
    return v;
  };
  const rigidSlots = new Map<string, number[]>();
  /** Material slot of each material of a mesh (-1: not a slot of the model). */
  const slotsOfMesh = (mesh: THREE.Mesh, key: string): number[] => {
    const mats = [mesh.material].flat() as THREE.Material[];
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      // Character meshes name each material after its slot's default texture.
      const defaults = slotsOfModel(key);
      return mats.map((m) => defaults.indexOf(m.name));
    }
    // Rigid models (weapons/models.ts buildStaticModel): one group per readModel submesh.
    let v = rigidSlots.get(key);
    if (!v) {
      const [pkg, id] = key.split(':').map(Number);
      rigidSlots.set(key, (v = (readModel(pkgs, { pkg, id })?.submeshes ?? []).map((sm) => sm.materialIndex ?? -1)));
    }
    return mats.map((_, i) => v![i] ?? -1);
  };

  // --- Applying. --------------------------------------------------------------------------
  const apply = (mesh: THREE.Mesh, key: string, textures: (string | undefined)[]) => {
    const sig = textures.join(',');
    const ud = mesh.userData as { repSkin?: string; repSlots?: number[] };
    if (ud.repSkin === sig) return;
    const slots = (ud.repSlots ??= slotsOfMesh(mesh, key));
    const mats = [mesh.material].flat() as (THREE.Material & { map?: THREE.Texture | null })[];
    mats.forEach((m, i) => {
      const k = textures[slots[i]];
      if (slots[i] < 0 || !k || !('map' in m) || !m.map) return;
      const tex = modelTexture(pkgs, k);
      if (tex && m.map !== tex) m.map = tex;
    });
    ud.repSkin = sig;
  };

  const meshesUnder = (root: THREE.Object3D | undefined, out: THREE.Mesh[]) => {
    root?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name.startsWith('model ')) out.push(o as THREE.Mesh);
    });
    return out;
  };

  let last = '';
  const current = () => {
    const rep = reputation();
    const body = skinFor(skins.body, rep, s.blood);
    const arms = skinFor(skins.arms, rep, s.blood);
    const wid = weaponId();
    const w = wid ? weaponSkin(wid) : undefined;
    const weapon = w ? skinFor(w.ch, rep, s.weapons[wid!] ?? 0) : undefined;
    return { rep, body, arms, wid, w, weapon };
  };

  /** Apply to the player's own meshes (cheap: every frame) and, when `deep`, the whole scene. */
  const update = (deep: boolean) => {
    const c = current();
    const sig = `${c.body?.suite}.${c.body?.set}|${c.arms?.suite}.${c.arms?.set}|${c.wid}:${c.weapon?.set}`;
    if (sig !== last) {
      log(`reputation ${c.rep.toFixed(1)}, blood ${s.blood.toFixed(1)} -> body suite ${c.body?.suite} set ${c.body?.set}, arms set ${c.arms?.set}${c.wid ? `, weapon ${c.wid} set ${c.weapon?.set ?? '-'}` : ''}`);
      last = sig;
    }
    const pb = svc<{ playerBody?: PlayerBodyLike | null }>('actors')?.playerBody ?? null;
    const own: THREE.Mesh[] = [];
    meshesUnder(pb?.body.root, own);
    meshesUnder(pb?.armsPivot, own);
    const held = new Set(own);
    for (const o of view.scene.children) if (o.name === 'stomp-player-puppet' || o.name === 'player-morph-back') meshesUnder(o, own);
    if (deep) {
      meshesUnder(view.scene, own);
      meshesUnder(view.viewmodel, own);
    }
    for (const m of own) {
      const key = m.name.slice(6);
      if (key === BODY_MODEL) c.body && apply(m, key, c.body.textures);
      else if (key === ARMS_MODEL) c.arms && apply(m, key, c.arms.textures);
      else if (held.has(m) && c.weapon && c.w?.model === key) apply(m, key, c.weapon.textures);
    }
  };

  // --- Blood level. -----------------------------------------------------------------------
  /**
   * Blood gained while morphing / transformed is not added: the Player's add override
   * (0x1002b2f0) only sets [+0x98] 0x20000000, and the change back then fills the level to the
   * maximum and applies the last set of the suite (0x10033189 -> 0x1002b3f0 / 0x10099ee0).
   */
  let pendingFill = false;
  const fillBlood = () => {
    s.blood = skins.body.maxBlood;
    const wid = weaponId();
    const w = wid ? weaponSkin(wid) : undefined;
    if (wid && w) s.weapons[wid] = w.ch.maxBlood;
    refresh();
  };
  const addBlood = (amount: number) => {
    if (!(amount > 0)) return;
    if (transformed()) {
      pendingFill = true;
      return;
    }
    s.blood = Math.min(skins.body.maxBlood, s.blood + amount);
    const wid = weaponId();
    const w = wid ? weaponSkin(wid) : undefined;
    if (wid && w) s.weapons[wid] = Math.min(w.ch.maxBlood, (s.weapons[wid] ?? 0) + amount);
  };
  const fx = svc<{ fx?: FxLike }>('world')?.fx;
  const observer: FxLike['spawners'][number] = (t, M) => {
    if (t.cls !== 'Blood Point Generator') return false;
    const e = M.elements;
    const p = view.player.position;
    const dx = p.x - e[12], dy = p.y - e[13], dz = p.z - e[14];
    const d = Math.hypot(dx, dy, dz);
    // Cone around the generator's +Z axis (the only retail template has a full 360 degrees).
    const ax = e[8], ay = e[9], az = e[10];
    const al = Math.hypot(ax, ay, az) * d;
    const angle = al > 1e-6 ? (Math.acos(Math.max(-1, Math.min(1, (ax * dx + ay * dy + az * dz) / al))) * 180) / Math.PI : 0;
    const amount = bloodFromGenerator(t.values as PropValue[], d, angle);
    if (amount > 0) {
      addBlood(amount);
      log(`blood point generator at ${d.toFixed(1)} units: +${amount.toFixed(1)} -> ${s.blood.toFixed(1)}`);
    }
    return false; // the fx system still draws the spray
  };
  fx?.spawners.unshift(observer);

  let scanIn = 0;
  /** Re-scan the scene on the next update. */
  const refresh = () => {
    scanIn = 0;
  };

  const offSave = registerSave<Persist>(
    ctx.services,
    'repskin',
    {
      save: () => ({ blood: s.blood, weapons: { ...s.weapons } }),
      load: (d) => {
        s.blood = Number.isFinite(d?.blood) ? d.blood : 0;
        s.weapons = { ...(d?.weapons ?? {}) };
        refresh();
      },
      reset: () => {
        Object.assign(s, fresh());
        refresh();
      },
    },
    { scope: 'game', priority: 26 },
  );

  Object.assign(window, {
    __repskin: {
      state: () => ({ ...current(), blood: s.blood, weapons: { ...s.weapons } }),
      setBlood: (n: number) => {
        s.blood = Math.max(0, Math.min(skins.body.maxBlood, n));
        refresh();
      },
      addBlood: (n: number) => addBlood(n),
      refresh,
      get pendingFill() {
        return pendingFill;
      },
    },
  });

  // services.repskin: the insanity system's change-back hook and the blood level.
  const service = {
    get blood() {
      return s.blood;
    },
    get maxBlood() {
      return skins.body.maxBlood;
    },
    addBlood: (n: number) => addBlood(n),
    /**
     * Called by the insanity system when the morph back to human ends: blood added while
     * transformed, or a level already at the maximum, fills the level and applies the last set.
     */
    changedBack: () => {
      const fill = pendingFill || s.blood >= skins.body.maxBlood;
      pendingFill = false;
      if (fill) {
        fillBlood();
        log(`changed back: blood filled to ${s.blood}`);
      }
    },
  };
  ctx.services.repskin = service;
  log(`ready: body ${skins.body.suites.map((x) => `${refKey(x.ref)}@${x.minReputation}`).join(' ')}, arms ${skins.arms.suites.length} suites, max ${skins.body.maxBlood}, -${skins.body.decay}/s`);

  return {
    name: 'repskin',
    update(dt: number) {
      if (!transformed() && s.blood > 0) s.blood = Math.max(0, s.blood - skins.body.decay * dt);
      for (const [id, v] of Object.entries(s.weapons)) {
        const w = weaponSkin(id);
        const nv = Math.max(0, v - (w?.ch.decay ?? 0.5) * dt);
        if (nv > 0) s.weapons[id] = nv;
        else delete s.weapons[id];
      }
      scanIn -= dt;
      const deep = scanIn <= 0;
      if (deep) scanIn = 0.5;
      update(deep);
    },
    dispose() {
      offSave();
      if (fx) {
        const i = fx.spawners.indexOf(observer);
        if (i >= 0) fx.spawners.splice(i, 1);
      }
      delete (window as unknown as { __repskin?: unknown }).__repskin;
      if (ctx.services.repskin === service) delete ctx.services.repskin;
    },
  };
}
