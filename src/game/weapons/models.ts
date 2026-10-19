// Meshes for hand-held objects (weapon models, muzzle flashes, thrown items, casings, decals).
//
// Skinned weapon models (the firearms: revolver 4:15, shotgun 4:26, tommy gun 4:88 carry a
// small rig whose bones mark the muzzle / casing port) become a Character so their bones can
// be looked up by index (Ranged Weapon p78 / p80 / p88). Rigid models (the shiv, throwables,
// muzzle flash cards) become a plain textured mesh. Both live in the model's own space
// (Y up, -Z forward; firearms point their barrel along -X).

import * as THREE from 'three/webgpu';
import { engineLightMaterial } from '../../app/engine-light';
import { findEntry, MDU_HEADER, readMaterial, readModel, TDU_TEXTURE, type PackageSet, type ResRef } from '../../formats/model';
import { decodeTexture } from '../../formats/texture';
import { readSkinnedModel } from '../../formats/skeleton';
import { Character, decodeCharacterTextures } from '../../app/character';

const texCache = new WeakMap<PackageSet, Map<string, THREE.DataTexture | null>>();

export function modelTexture(pkgs: PackageSet, key: string): THREE.DataTexture | null {
  let m = texCache.get(pkgs);
  if (!m) texCache.set(pkgs, (m = new Map()));
  if (m.has(key)) return m.get(key)!;
  const [pkg, id] = key.split(':').map(Number);
  const tdu = pkgs.get(pkg)?.tdu;
  const entry = findEntry(tdu, TDU_TEXTURE, id);
  const src = tdu && entry ? decodeTexture(tdu, entry, { rowOrder: 'stored' }) : null;
  let t: THREE.DataTexture | null = null;
  if (src) {
    t = new THREE.DataTexture(src.rgba, src.width, src.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.userData.hasAlpha = src.hasAlpha;
    t.needsUpdate = true;
  }
  m.set(key, t);
  return t;
}

export interface StaticModelOptions {
  /** Additive, unlit, no depth write (muzzle flashes). */
  additive?: boolean;
  /** Unlit (emissive) material. */
  unlit?: boolean;
}

/** Rigid textured mesh of a model (not cached: each call builds geometry + materials). */
export function buildStaticModel(pkgs: PackageSet, ref: ResRef, opts: StaticModelOptions = {}): THREE.Group | undefined {
  const m = readModel(pkgs, ref);
  if (!m || !m.submeshes.length) return undefined;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
  const total = m.submeshes.reduce((n, s) => n + s.indices.length, 0);
  const index = new Uint32Array(total);
  const mats: THREE.Material[] = [];
  let o = 0;
  m.submeshes.forEach((s, i) => {
    for (let t = 0; t + 2 < s.indices.length; t += 3) {
      index[o + t] = s.indices[t];
      index[o + t + 1] = s.indices[t + 2];
      index[o + t + 2] = s.indices[t + 1];
    }
    g.addGroup(o, s.indices.length, i);
    o += s.indices.length;
    const map = s.textureKey ? modelTexture(pkgs, s.textureKey) : null;
    if (opts.additive) {
      mats.push(
        new THREE.MeshBasicNodeMaterial({ map, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      );
    } else if (opts.unlit) {
      mats.push(new THREE.MeshBasicNodeMaterial({ map, color: 0xffffff, side: THREE.DoubleSide, alphaTest: map?.userData.hasAlpha ? 0.5 : 0 }));
    } else {
      mats.push(
        // Lit like the engine's dynamic objects (engine-light.ts).
        engineLightMaterial(
          new THREE.MeshStandardNodeMaterial({
            map,
            color: map ? 0xffffff : 0x777777,
            roughness: 0.7,
            metalness: 0.1,
            side: THREE.DoubleSide,
            alphaTest: map?.userData.hasAlpha ? 0.5 : 0,
          }),
          { precomputed: false },
        ),
      );
    }
  });
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, mats);
  mesh.name = `model ${ref.pkg}:${ref.id}`;
  const root = new THREE.Group();
  root.name = mesh.name;
  root.add(mesh);
  return root;
}

/** A hand-held model: skinned (Character, bones addressable) when it has a rig, else rigid. */
export interface HeldModel {
  root: THREE.Object3D;
  character?: Character;
  /** Bone by index (skinned models), else the root. */
  bone(index: number): THREE.Object3D;
  dispose(): void;
}

export function buildHeldModel(pkgs: PackageSet, ref: ResRef): HeldModel | undefined {
  const sk = readSkinnedModel(pkgs, ref);
  if (sk) {
    const ch = new Character(sk, [], decodeCharacterTextures(sk, pkgs));
    ch.root.name = `held ${ref.pkg}:${ref.id}`;
    return {
      root: ch.root,
      character: ch,
      bone: (i) => (i >= 0 && ch.skeleton.bones[i]) || ch.root,
      dispose: () => ch.dispose(),
    };
  }
  const g = buildStaticModel(pkgs, ref);
  if (!g) return undefined;
  return {
    root: g,
    bone: () => g,
    dispose: () => {
      g.removeFromParent();
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          for (const mat of [m.material].flat()) mat.dispose();
        }
      });
    },
  };
}

/** Texture key of a model's first material (header material list), also for models whose
 * geometry model.ts can't decode (the muzzle-flash cards 4:180..182 use another face layout). */
export function firstMaterialTexture(pkgs: PackageSet, ref: ResRef): string | undefined {
  const mdu = pkgs.get(ref.pkg)?.mdu;
  const eh = findEntry(mdu, MDU_HEADER, ref.id);
  if (!mdu || !eh || eh.size < 12) return undefined;
  const h = mdu.data(eh);
  const p = 8 + (h.getUint8(2) & 2 ? 4 : 0);
  if (p + 8 > h.byteLength || h.getUint32(p, true) < 1) return undefined;
  const r = { id: h.getUint16(p + 4, true), pkg: h.getUint16(p + 6, true) };
  return readMaterial(pkgs, r)?.layers[0]?.texture;
}

/** Two crossed additive cards (muzzle flash fallback), long axis along -X like the barrels. */
export function flashCards(pkgs: PackageSet, ref: ResRef, size = 0.22): THREE.Group {
  const key = firstMaterialTexture(pkgs, ref);
  const map = key ? modelTexture(pkgs, key) : null;
  const mat = new THREE.MeshBasicNodeMaterial({ map, color: map ? 0xffffff : 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const g = new THREE.Group();
  g.name = `flash ${ref.pkg}:${ref.id}`;
  for (const rot of [0, Math.PI / 2]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.6, size), mat);
    m.position.x = -size * 0.7;
    m.rotation.x = rot;
    g.add(m);
  }
  return g;
}
