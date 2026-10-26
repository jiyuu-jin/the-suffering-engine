// Template parameters of the special moves and bosses, decoded from the retail templates
// (docs/game-logic.md §15.7). Pure functions over a package set, so tests can check the
// decoded numbers without a renderer. Tags as in the docs: [verified 0xADDR] read in the
// Suffering.rfl code, [data] from the retail values, [inferred] otherwise.

import type { EntityPackageSet, PropValue } from '../../../formats/entities';
import type { ResRef } from '../../../formats/model';
import type * as THREE from 'three/webgpu';
import type { Actor } from '../actor';
import type { ClipRef } from '../clipmap';
import { keys, num, readTemplate, ref, refs, nums } from './runtime';

// ---------------------------------------------------------------------------------------
// Black One (class 0xffaeb496; ctor 0x1006f6e0, update 0x10070310, events 0x1006f260)

/** One Black One Attack template (class 0x8a6cebec) [verified 0x1006fcf0 / 0x1006e9f0]. */
export interface BlackOneAttack {
  ref: ResRef;
  /** Attack slot n = the Black One's p(54 + n): 0 melee, 2 three-limb strike, 3 fireballs,
   *  4 teleport missile, 5 pull-in follow-up (only on Enable). */
  slot: number;
  clip?: ClipRef;
  /** p3..p4 playback speed range. */
  speed: [number, number];
  /** p5..p6 player distance range (m). */
  range: [number, number];
  /** p7..p8 player bearing range (degrees, 0 = straight ahead). */
  arc: [number, number];
}

/** Parameters of one Black One stage template (10:1024 -> p46 10:1699 -> 10:1700). */
export interface BlackOneStage {
  ref: ResRef;
  /** p39..p40 / p41..p42: retreat timers while the player is within / beyond p43 (s). */
  nearTimer: [number, number];
  farTimer: [number, number];
  /** p43 near / far radius (m). */
  nearRadius: number;
  /** p44..p45 wait after the retreat clip before teleporting (s). */
  teleportWait: [number, number];
  /** p46 next stage template (undefined on the last stage). */
  next?: ResRef;
  idle?: ClipRef;
  /** p48 / p49 paired taunt clips (index shared by all Black Ones). */
  taunts: ClipRef[];
  tauntsAfter: (ClipRef | undefined)[];
  /** p50 appear, p51 retreat, p52 stage change, p53 death clips. */
  appear?: ClipRef;
  retreat: ClipRef[];
  stageChange?: ClipRef;
  death?: ClipRef;
  attacks: BlackOneAttack[];
  /** p60 fireball generator (slot 3), p61 teleport-missile generator (slot 4). */
  fireball?: ResRef;
  teleport?: ResRef;
  /** p62 heart Breakable, p63 its bone / hardpoint. */
  heart?: ResRef;
  heartBone: number;
  /** p64 / p65 heart tint at full / no health (0xRRGGBB). */
  tintFull: number;
  tintEmpty: number;
  /** p66 hurt-flash time (s), p67 hurt sounds. */
  hurtFlash: number;
  hurtSounds: string[];
  /** p68 heart health on entering this stage (% of its max). */
  stageHealth: number;
  /** Message slots: inputs p69 On, p70 / p71 exclude off / on, p72 Enable (pull-in), p73 Disable;
   *  outputs p74 Triggered, p75 stage change, p76 Died, p77 appear (Enable), p78 vanish (Disable). */
  msg: { on: number; include: number; exclude: number; pull: number; release: number; triggered: number; stage: number; died: number; appear: number; vanish: number };
  /** p22 weapon bones and p23 their Melee Weapons; damage per blow (Melee Weapon p68..p69). */
  weaponBones: number[];
  blowDamage: number;
}

/** A Missile behind an Object Generator (first Missile child): speed (m/s), effects, impact. */
export interface MissileInfo {
  missile?: ResRef;
  speed: number;
  /** Impact generators (Missile p34) and their Radius Damage (p0 max at the centre, p1 min at the radius p5, p10 type; inner is 0). */
  impact: ResRef[];
  radius?: { max: number; min: number; inner: number; outer: number; type: number };
  /** Missile p27 attachments (Teleport Effect: p0 = message sent to the firing object). */
  teleportMessage?: number;
  sounds: string[];
}

const clip = (v: PropValue | undefined): ClipRef | undefined => ref(v);

export function blackOneStage(pkgs: EntityPackageSet, r: ResRef): BlackOneStage | undefined {
  const t = readTemplate(pkgs, r);
  if (!t || t.cls !== 'Black One') return undefined;
  const v = t.v;
  const attacks: BlackOneAttack[] = [];
  for (let slot = 0; slot <= 5; slot++) {
    for (const ar of refs(v[54 + slot])) {
      const a = readTemplate(pkgs, ar);
      if (a?.cls !== 'Black One Attack') continue;
      const w = a.v;
      attacks.push({
        ref: ar,
        slot,
        clip: clip(w[0]),
        speed: [num(w[3], 1), Math.max(num(w[3], 1), num(w[4], 1))],
        range: [num(w[5], 0), num(w[6], 0)],
        arc: [num(w[7], -180), num(w[8], 180)],
      });
    }
  }
  const next = ref(v[46]);
  const weapons = refs(v[23]).map((w) => readTemplate(pkgs, w)).filter((w) => w?.cls === 'Melee Weapon');
  return {
    ref: r,
    nearTimer: [num(v[39], 30), num(v[40], 40)],
    farTimer: [num(v[41], 15), num(v[42], 30)],
    nearRadius: num(v[43], 15),
    teleportWait: [num(v[44], 3), num(v[45], 5)],
    next: next && readTemplate(pkgs, next)?.cls === 'Black One' ? next : undefined,
    idle: clip(v[47]),
    taunts: refs(v[48]),
    tauntsAfter: refs(v[48]).map((_, i) => refs(v[49])[i]),
    appear: clip(v[50]),
    retreat: refs(v[51]),
    stageChange: clip(v[52]),
    death: clip(v[53]),
    attacks,
    fireball: ref(v[60]),
    teleport: ref(v[61]),
    heart: ref(v[62]),
    heartBone: num(v[63], 5),
    tintFull: num(v[64], 0xff0000) & 0xffffff,
    tintEmpty: num(v[65], 0x060000) & 0xffffff,
    hurtFlash: num(v[66], 0.5),
    hurtSounds: keys(v[67]),
    stageHealth: num(v[68], 100),
    msg: {
      on: num(v[69], 1),
      include: num(v[70], 0),
      exclude: num(v[71], 0),
      pull: num(v[72], 4),
      release: num(v[73], 5),
      triggered: num(v[74], 6),
      stage: num(v[75], 0),
      died: num(v[76], 19),
      appear: num(v[77], 4),
      vanish: num(v[78], 5),
    },
    weaponBones: nums(v[22]),
    blowDamage: weapons.length ? (num(weapons[0]!.v[68], 20) + num(weapons[0]!.v[69], 20)) / 2 : 20,
  };
}

/** The stage chain from a first Black One template (p46 links), at most 4 long. */
export function blackOneStages(pkgs: EntityPackageSet, first: ResRef): BlackOneStage[] {
  const out: BlackOneStage[] = [];
  let r: ResRef | undefined = first;
  while (r && out.length < 4) {
    const s = blackOneStage(pkgs, r);
    if (!s) break;
    out.push(s);
    r = s.next;
  }
  return out;
}

/** Missile fired by an Object Generator (Black One p60 / p61, ranged weapons). */
export function generatorMissile(pkgs: EntityPackageSet, gen: ResRef | undefined): MissileInfo | undefined {
  const g = readTemplate(pkgs, gen);
  if (!g || g.cls !== 'Object Generator') return undefined;
  const m = refs(g.v[0]).find((r) => readTemplate(pkgs, r)?.cls === 'Missile');
  const mv = readTemplate(pkgs, m)?.v ?? [];
  const impact = refs(mv[34]);
  let radius: MissileInfo['radius'];
  for (const ig of impact) {
    for (const c of refs(readTemplate(pkgs, ig)?.v[0])) {
      const rd = readTemplate(pkgs, c);
      if (rd?.cls === 'Radius Damage') radius = { max: num(rd.v[0], 0), min: num(rd.v[1], 0), outer: num(rd.v[5], 0), inner: 0, type: num(rd.v[10], 0) }; // p5 radius, linear from the centre (RFL 0x10125c70)
    }
  }
  let teleportMessage: number | undefined;
  for (const a of refs(mv[27])) {
    const t = readTemplate(pkgs, a);
    if (t?.cls === 'Teleport Effect') teleportMessage = num(t.v[0], 4);
  }
  return { missile: m, speed: num(mv[1], 0) / 2048, impact, radius, teleportMessage, sounds: keys(g.v[36]) };
}

// ---------------------------------------------------------------------------------------
// Nooseman (class 0x30122bac; KillObject 0x10084a50, GrabAttack 0x10082c60 / 0x10082e60,
// Grapple 0x100833c0 / 0x10083a20, rope setter 0x10081650)

export interface NoosemanParams {
  /** p175 low-point bone (grab test, drop length), p180 rope bone, p181 body-attach bone. */
  lowBone: number;
  ropeBone: number;
  bodyBone: number;
  /** p182 the model's native rope length (m), p183 rope length at start, p184 longest drop, p186 clearance (m). */
  ropeNative: number;
  ropeStart: number;
  maxDrop: number;
  clearance: number;
  /** p185 Nooseman Drop Position (its group). */
  drops: number;
  /** NooseManKillObjectBehavior (p178): grab radius / vertical tolerance (m), cooldown after a grab / a miss (s). */
  grabRadius: number;
  grabHeight: number;
  cooldownHit: number;
  cooldownMiss: number;
  /** NoosemanGrabAttackBehavior (p179). */
  dropSpeed: number;
  bounce?: ResRef;
  landClip?: ClipRef;
  dropClip?: ClipRef;
  reelSpeed: number;
  reelStartClip?: ClipRef;
  reelClip?: ClipRef;
  appearFx?: ResRef;
  dropSounds: string[];
  showDelay: number;
  vanishFx?: ResRef;
  vanishSounds: string[];
  /** NoosemanGrabAttackGrappleBehavior (p177). */
  grapple: {
    loop: [ClipRef | undefined, ClipRef | undefined];
    hardpoint: number;
    grace: number;
    lift: number;
    meterMax: number;
    hold: number;
    dps: [number, number];
    kill: [ClipRef | undefined, ClipRef | undefined];
    release: [ClipRef | undefined, ClipRef | undefined];
    fader?: ResRef;
    darken: number;
    npcHold: number;
    npcDamage: number;
  };
}

export function noosemanParams(pkgs: EntityPackageSet, v: PropValue[]): NoosemanParams {
  const ko = readTemplate(pkgs, ref(v[178]))?.v ?? [];
  const ga = readTemplate(pkgs, ref(v[179]))?.v ?? [];
  const gr = readTemplate(pkgs, ref(v[177]))?.v ?? [];
  return {
    lowBone: num(v[175], 18),
    ropeBone: num(v[180], 0),
    bodyBone: num(v[181], 7),
    ropeNative: num(v[182], 5.294),
    ropeStart: num(v[183], 2.5),
    maxDrop: num(v[184], 20),
    clearance: num(v[186], 0.15),
    drops: num(Array.isArray(v[185]) ? v[185][0] : v[185], 0),
    grabRadius: num(ko[2], 1),
    grabHeight: num(ko[3], 0.8),
    cooldownHit: num(ko[4], 3),
    cooldownMiss: num(ko[5], 0.5),
    dropSpeed: num(ga[2], 10),
    bounce: ref(ga[3]),
    landClip: clip(ga[4]),
    dropClip: clip(ga[5]),
    reelSpeed: num(ga[6], 4.5),
    reelStartClip: clip(ga[8]),
    reelClip: clip(ga[9]),
    appearFx: ref(ga[10]),
    dropSounds: keys(ga[11]),
    showDelay: num(ga[13], 0.03),
    vanishFx: ref(ga[14]),
    vanishSounds: keys(ga[15]),
    grapple: {
      loop: [clip(gr[2]), clip(gr[3])],
      hardpoint: num(gr[4], 85),
      grace: num(gr[5], 0.25),
      lift: num(gr[6], 0.25),
      meterMax: num(gr[7], 3),
      hold: num(gr[8], 5),
      dps: [num(gr[9], 15), num(gr[10], 15)],
      kill: [clip(gr[11]), clip(gr[12])],
      release: [clip(gr[13]), clip(gr[14])],
      fader: ref(gr[15]),
      darken: num(gr[16], 85),
      npcHold: num(gr[18], 3),
      npcDamage: num(gr[19], 30),
    },
  };
}

/** Player grapple clips (Player template p316 press value, p317..p322 clips, rig 328) [verified 0x100833c0]. */
export const PLAYER_GRAPPLE = {
  /** Struggle press value (p316). */
  press: 1,
  loop: [{ pkg: 2, id: 295 }, { pkg: 2, id: 294 }] as [ClipRef, ClipRef],
  escape: [{ pkg: 2, id: 298 }, { pkg: 2, id: 297 }] as [ClipRef, ClipRef],
  death: [{ pkg: 2, id: 296 }, { pkg: 2, id: 293 }] as [ClipRef, ClipRef],
};

/** The actor is fighting the player right now (combat behaviour or grudge, target = player). */
export function fightingPlayer(a: { alive: boolean; inCombat: boolean; activity: string }): boolean {
  return a.alive && a.inCombat && a.activity.endsWith('>player');
}

/** A special's fight target: the player or a character, with its feet position. */
export type FightTarget = { player: true; actor?: undefined; pos: THREE.Vector3Like } | { player: false; actor: Actor; pos: THREE.Vector3Like };

/**
 * The target a creature's kill behaviour works on: its KillEnemies pick, the player or a live,
 * shown character (an NPC such as Clem) [verified: the kill objects read the target from the
 * KillEnemies that started them, whatever it is]. Undefined when not fighting, for a dead or
 * hidden target, or for an object target (left to the generic AI).
 */
export function fightTarget(
  a: { alive: boolean; inCombat: boolean; currentTarget?: Readonly<{ player?: boolean; actor?: Actor; prop?: number }> },
  env: { playerAlive: boolean; player: { position: THREE.Vector3Like }; ignorePlayer?: boolean },
): FightTarget | undefined {
  if (!a.alive || !a.inCombat) return undefined;
  const t = a.currentTarget;
  if (!t) return undefined;
  // Port option "Enemies ignore the player": no special works on him (a pick not yet dropped).
  if (t.player) return env.playerAlive && !env.ignorePlayer ? { player: true, pos: env.player.position } : undefined;
  const o = t.actor;
  return o && o.alive && !o.hidden ? { player: false, actor: o, pos: o.position } : undefined;
}

/**
 * Where a special aims with no fight target: the player (the port's fallback while an attack
 * that lost its target finishes), or with the port option "Enemies ignore the player" a point
 * 5 m ahead of the body, so nothing is aimed at him.
 */
export function noTargetAim(
  a: { position: THREE.Vector3Like; yaw: number },
  env: { player: { position: THREE.Vector3Like }; ignorePlayer?: boolean },
): THREE.Vector3Like {
  if (!env.ignorePlayer) return env.player.position;
  const p = a.position;
  return { x: p.x - Math.sin(a.yaw) * 5, y: p.y, z: p.z - Math.cos(a.yaw) * 5 };
}

/** Melee blow of a character: its Melee Weapon damage (p68..p69 mean) x an Attack's p6 multiplier. */
export function meleeBlow(pkgs: EntityPackageSet, v: PropValue[], attack: ResRef | undefined): { clip?: ClipRef; reach: number; damage: number; force: number } | undefined {
  const at = readTemplate(pkgs, attack);
  if (!at || at.cls !== 'Attack') return undefined;
  const w = refs(v[52]).map((r) => readTemplate(pkgs, r)).find((t) => t?.cls === 'Melee Weapon');
  const base = w ? (num(w.v[68], 10) + num(w.v[69], 10)) / 2 : 10;
  // Impact force: the weapon's p69 x the Attack's p7 (Melee Weapon 0x100caa61..0x100caa89) [verified].
  return { clip: clip(at.v[0]), reach: num(at.v[16], 2), damage: base * num(at.v[6], 1), force: (w ? num(w.v[69], 0) : 0) * num(at.v[7], 1) };
}

// ---------------------------------------------------------------------------------------
// Fester (class 0xe2ebcb51; KillMelee 0x10075b20.., ChargeAttack 0x100765d0..)

export interface FesterParams {
  rat?: ResRef;
  deathClips: ClipRef[];
  /** FesterKillMeleeBehavior p13 min distance, p14 clip, p15..p16 interval (first after p15). */
  releaseMinDist: number;
  releaseClip?: ClipRef;
  releaseEvery: [number, number];
  /** p19 cone (deg), p20..p21 distance band (m), p22..p23 cooldown (s). */
  chargeCone: number;
  chargeRange: [number, number];
  chargeEvery: [number, number];
  /** FesterChargeAttackBehavior p2 wind-up, p3 run, p4 skid, p5 strike, p6 steer stop, p7 side limit. */
  windup?: ClipRef;
  run?: ClipRef;
  skid?: ClipRef;
  strike?: { clip?: ClipRef; reach: number; damage: number; force?: number };
  strikeDamage: number;
  steerStop: number;
  sideLimit: number;
}

export function festerParams(pkgs: EntityPackageSet, v: PropValue[]): FesterParams {
  const km = readTemplate(pkgs, ref(v[178]))?.v ?? [];
  const ch = readTemplate(pkgs, ref(v[179]))?.v ?? [];
  const deathClips = refs(v[72]).flatMap((d) => {
    const t = readTemplate(pkgs, d);
    return t?.cls === 'DeathBehavior' ? refs(t.v[2]) : [];
  });
  const strike = meleeBlow(pkgs, v, ref(ch[5]));
  return {
    rat: readTemplate(pkgs, ref(v[177]))?.cls === 'Rat' ? ref(v[177]) : undefined,
    deathClips,
    releaseMinDist: num(km[13], 2),
    releaseClip: clip(km[14]),
    releaseEvery: [num(km[15], 11), Math.max(num(km[15], 11), num(km[16], 16))],
    chargeCone: num(km[19], 30),
    chargeRange: [num(km[20], 5), num(km[21], 20)],
    chargeEvery: [num(km[22], 1.5), Math.max(num(km[22], 1.5), num(km[23], 3.5))],
    windup: clip(ch[2]),
    run: clip(ch[3]),
    skid: clip(ch[4]),
    strike,
    strikeDamage: strike?.damage ?? 30,
    steerStop: num(ch[6], 3),
    sideLimit: num(ch[7], 2),
  };
}

// ---------------------------------------------------------------------------------------
// Mainliner (class 0x127243e5; KillObject 0x1007dc70.., JumpAttack 0x10073b90 / 0x10072c20,
// launch 0x100736b0 / 0x100743c0, grapple 0x1007e290 / 0x1007f9f0)

export interface MainlinerParams {
  /** MainlinerKillObjectBehavior p24..p25 cooldown, p26 max height difference, p27..p28 band (m). */
  cooldown: [number, number];
  maxRise: number;
  band: [number, number];
  /** MainlinerJumpAttackBehavior: p2 damage base, p3 leap Attack (clip, p15..p16 range), p5 approach
   *  timeout, p6 grab cone (deg), p7..p8 target height window, p9 missed landing clip,
   *  p4 / p11 stick-front / stick-back Attacks, p12 struggle jitter, p13 ride time (s). */
  jump: MainlinerJump;
  /** p178 jump off after the finisher, p179 thrown off (JumpBehavior launch / airborne / landing). */
  jumpOff: [ClipRef | undefined, ClipRef | undefined, ClipRef | undefined];
  thrown: [ClipRef | undefined, ClipRef | undefined, ClipRef | undefined];
}

export interface MainlinerJump {
  base: number;
  leap?: ClipRef;
  leapRange: [number, number];
  leapDamage: number;
  timeout: number;
  cone: number;
  height: [number, number];
  missed?: ClipRef;
  stick: [{ clip?: ClipRef; mult: number; fx?: ResRef }, { clip?: ClipRef; mult: number; fx?: ResRef }];
  jitter: number;
  ride: number;
}

export function mainlinerJump(pkgs: EntityPackageSet, v: PropValue[], j: PropValue[]): MainlinerJump {
  const leap = readTemplate(pkgs, ref(j[3]))?.v ?? [];
  const stick = (r: ResRef | undefined) => {
    const t = readTemplate(pkgs, r)?.v ?? [];
    return { clip: clip(t[0]), mult: num(t[6], 1.5), fx: ref(t[11]) };
  };
  return {
    base: num(j[2], 20),
    leap: clip(leap[0]),
    leapRange: [num(leap[15], 3), num(leap[16], 7.5)],
    leapDamage: meleeBlow(pkgs, v, ref(j[3]))?.damage ?? 10,
    timeout: num(j[5], 2),
    cone: num(j[6], 30),
    height: [num(j[7], -1), num(j[8], 2)],
    missed: clip(j[9]),
    stick: [stick(ref(j[4])), stick(ref(j[11]))],
    jitter: num(j[12], 0.2),
    ride: num(j[13], 2),
  };
}

export function mainlinerParams(pkgs: EntityPackageSet, v: PropValue[]): MainlinerParams {
  const ko = readTemplate(pkgs, ref(v[177]))?.v ?? [];
  const jb = (r: ResRef | undefined): [ClipRef | undefined, ClipRef | undefined, ClipRef | undefined] => {
    const t = readTemplate(pkgs, r)?.v ?? [];
    return [clip(t[4]), clip(t[5]), clip(t[6])];
  };
  return {
    cooldown: [num(ko[24], 10), Math.max(num(ko[24], 10), num(ko[25], 15))],
    maxRise: num(ko[26], 1.5),
    band: [num(ko[27], 3), num(ko[28], 9)],
    jump: mainlinerJump(pkgs, v, readTemplate(pkgs, ref(v[176]))?.v ?? []),
    jumpOff: jb(ref(v[178])),
    thrown: jb(ref(v[179])),
  };
}

/**
 * A character as a Mainliner's victim (Character p141..p143) [verified]: p143 != 0 lets a
 * Mainliner jump at him (vt 0x134 0x100870f0, the jump trigger 0x1007ee30 and the launch's
 * contact test); p141 / p142 are his front / back incapacitate Attacks, which the grapple start
 * (0x1007e290) deals to him (Attack p6 x the jump's p2, type p7, effect p11: 0x10087160) and whose
 * clip p0 the Mainliner plays on him at rate 1. Retail: Clem 10:642, Dallas 10:391: p143 1,
 * p141 = p142 = 10:205 (clip 10:228, the front stick clip; p6 0).
 */
export interface MainlinerVictim {
  rideable: boolean;
  incapacitate: [{ clip?: ClipRef; mult: number; fx?: ResRef }, { clip?: ClipRef; mult: number; fx?: ResRef }];
}

export function mainlinerVictim(pkgs: EntityPackageSet, v: PropValue[]): MainlinerVictim {
  const at = (r: ResRef | undefined) => {
    const t = readTemplate(pkgs, r);
    return t?.cls === 'Attack' ? { clip: clip(t.v[0]), mult: num(t.v[6], 0), fx: ref(t.v[11]) } : { mult: 0 };
  };
  return { rideable: num(v[143], 0) !== 0, incapacitate: [at(ref(v[141])), at(ref(v[142]))] };
}

/** Player side of the Mainliner ride (Player p303 press value, p304..p309 clips, p310 attach bone) [verified 0x1007e290]. */
export const PLAYER_RIDE = {
  press: 0.035,
  stick: [{ pkg: 2, id: 253 }, { pkg: 2, id: 251 }] as [ClipRef, ClipRef],
  thrown: [{ pkg: 2, id: 255 }, { pkg: 2, id: 256 }] as [ClipRef, ClipRef],
  jumpOff: [{ pkg: 2, id: 254 }, { pkg: 2, id: 252 }] as [ClipRef, ClipRef],
  /** Unlock marker of the player's stick clip (clip seconds): the struggle starts there. */
  unlock: 0.61,
};

// ---------------------------------------------------------------------------------------
// Burrower (class 0x285a9a1f; think 0x10070b50, events 0x10071040, BurrowerKillMelee /
// BurrowerFlyBy 0x10071ad0 / 0x100719e0 / 0x10071530 / 0x10071700)

export interface BurrowerParams {
  /** p182 movement rumble sound. */
  rumble: string[];
  /** p186 HitReact clip played when it dies underground (pops out dead). */
  deathUnder?: ClipRef;
  /** p187 Hole: its generators (p2, p3) spawned on every Recede. */
  hole: ResRef[];
  /** p188 % chance / p189 clip of the kill-player finisher. */
  finisherChance: number;
  finisherClip?: ClipRef;
  /** BurrowerKillMeleeBehavior p11..p12 fly-by check timer, p13 % chance, p14..p15 final
   *  approach (m), p16 pass offset (m), p17 passes. */
  flyByEvery: [number, number];
  flyByChance: number;
  flyByFinal: [number, number];
  flyByOffset: number;
  flyByPasses: number;
  /** Default Burrower Material Effects (no Material Type): p9 dirt mound per heavy step, p15 emerge. */
  trail?: ResRef;
  emerge?: ResRef;
  /** Clips whose Emerge / Recede markers the port follows (melee attacks + hit reactions). */
  surfacing: ClipRef[];
}

export function burrowerParams(pkgs: EntityPackageSet, v: PropValue[]): BurrowerParams {
  const km = readTemplate(pkgs, ref(v[190]))?.v ?? [];
  const hr = readTemplate(pkgs, ref(Array.isArray(v[186]) ? v[186][0] : v[186]))?.v ?? [];
  const hole = readTemplate(pkgs, ref(v[187]))?.v ?? [];
  const mats = refs(v[49]).map((r) => readTemplate(pkgs, r)).filter((t) => t?.cls === 'Burrower Material Effects');
  const def = mats.find((t) => !t!.v[0]) ?? mats[0];
  const surfacing: ClipRef[] = [];
  const mab = readTemplate(pkgs, ref(v[87]));
  for (const at of refs(mab?.v[2])) {
    const c = clip(readTemplate(pkgs, at)?.v[0]);
    if (c) surfacing.push(c);
  }
  for (const h of refs(v[70])) for (const c of refs(readTemplate(pkgs, h)?.v[7])) surfacing.push(c);
  return {
    rumble: keys(v[182]),
    deathUnder: refs(hr[7])[0],
    hole: [ref(hole[2]), ref(hole[3])].filter((r): r is ResRef => !!r),
    finisherChance: num(v[188], 100),
    finisherClip: clip(v[189]),
    flyByEvery: [num(km[11], 10), Math.max(num(km[11], 10), num(km[12], 15))],
    flyByChance: num(km[13], 70),
    flyByFinal: [num(km[14], 7.5), Math.max(num(km[14], 7.5), num(km[15], 10))],
    flyByOffset: num(km[16], 4),
    flyByPasses: num(km[17], 3),
    trail: def ? ref(def.v[9]) : undefined,
    emerge: def ? ref(def.v[15]) : undefined,
    surfacing,
  };
}

// ---------------------------------------------------------------------------------------
// Inferna (class 0xec6354a8; TakeDamage 0x10078400, update 0x10078cf0, behaviours 0x1007a730..)

export interface RadiusDamage {
  max: number;
  min: number;
  inner: number;
  outer: number;
  type: number;
}

/** Generator children: effects (everything but Radius Damage) and its Radius Damage. */
export function generatorParts(pkgs: EntityPackageSet, gen: ResRef | undefined): { effects: ResRef[]; radius?: RadiusDamage; sounds: string[] } {
  const g = readTemplate(pkgs, gen);
  const effects: ResRef[] = [];
  let radius: RadiusDamage | undefined;
  for (const c of refs(g?.v[0])) {
    const t = readTemplate(pkgs, c);
    if (t?.cls === 'Radius Damage') radius = { max: num(t.v[0], 0), min: num(t.v[1], 0), outer: num(t.v[5], 0), inner: 0, type: num(t.v[10], 0) }; // p5 radius (p2 / p3 are force)
    else if (t) effects.push(c);
  }
  return { effects, radius, sounds: keys(g?.v[36]) };
}

export interface InfernaParams {
  /** p184 starts flaming, p185..p186 burn time, p187 flame seconds lost per damage point. */
  startLit: boolean;
  burn: [number, number];
  burnPerDamage: number;
  /** p188 flaming model, p190 ash model, p191 Ash Attachments (bones p0 / effects p1). */
  flameModel?: ResRef;
  ashModel?: ResRef;
  ashFx: { bone: number; fx: ResRef }[];
  /** p192 ignite message, p193 flame loop, p196 burning voice lines every p199..p200 s. */
  igniteMsg: number;
  flameLoop: string[];
  voices: string[];
  voiceEvery: [number, number];
  /** InfernaStartFlaming p2 / p3 clips; InfernaAsh p2..p5 clips, p6..p7 ash time. */
  ignite: [ClipRef | undefined, ClipRef | undefined];
  ash: [ClipRef | undefined, ClipRef | undefined, ClipRef | undefined, ClipRef | undefined];
  ashTime: [number, number];
  /** InfernaKillObject p2 ignite range, p3 approach stop, p4 circle radius limit, p5 circle radius. */
  igniteRange: number;
  approach: number;
  circleLimit: number;
  circleRadius: number;
  /** p182 / p183 circling clips (two directions). */
  circle: [ClipRef | undefined, ClipRef | undefined];
  /** InfernaFlamingKill: p2 flame generator, p3 flame clip, p4..p5 decision timer, p6..p7 flame band,
   *  p8..p9 fireball band, p10 % chance of moving into the fireball band. */
  flame: { gen?: ResRef; clip?: ClipRef; parts: ReturnType<typeof generatorParts> };
  decide: [number, number];
  flameBand: [number, number];
  ballBand: [number, number];
  ballChance: number;
  /** Fireball: ProjectileAttack p88 (Attack clip, p19..p20 interval) throwing p55's BouncingObject. */
  ball: { clip?: ClipRef; speed: number; parts: ReturnType<typeof generatorParts>; boneFrom: number };
}

export function infernaParams(pkgs: EntityPackageSet, v: PropValue[]): InfernaParams {
  const ash = readTemplate(pkgs, ref(v[175]))?.v ?? [];
  const sf = readTemplate(pkgs, ref(v[176]))?.v ?? [];
  const ko = readTemplate(pkgs, ref(v[177]))?.v ?? [];
  const fk = readTemplate(pkgs, ref(v[178]))?.v ?? [];
  const ma = (r: ResRef | undefined) => clip(readTemplate(pkgs, r)?.v[3]) ?? clip(readTemplate(pkgs, r)?.v[2]);
  const aa = readTemplate(pkgs, ref(v[191]))?.v ?? [];
  const ashBones = nums(aa[0]);
  const pa = readTemplate(pkgs, ref(v[88]))?.v ?? [];
  const at = readTemplate(pkgs, refs(pa[2])[0])?.v ?? [];
  const bo = refs(v[55]).map((r) => ({ r, t: readTemplate(pkgs, r) })).find((x) => x.t?.cls === 'BouncingObject');
  const parts55 = refs(v[55]);
  const boneFrom = bo ? nums(v[54])[parts55.findIndex((r) => r.pkg === bo.r.pkg && r.id === bo.r.id)] ?? 0 : 0;
  return {
    startLit: num(v[184], 0) !== 0,
    burn: [num(v[185], 20), Math.max(num(v[185], 20), num(v[186], 40))],
    burnPerDamage: num(v[187], 0.3),
    flameModel: ref(v[188]),
    ashModel: ref(v[190]),
    ashFx: refs(aa[1]).map((fx, i) => ({ bone: ashBones[i] ?? 0, fx })),
    igniteMsg: num(v[192], 0),
    flameLoop: keys(v[193]),
    voices: keys(v[196]),
    voiceEvery: [num(v[199], 10), Math.max(num(v[199], 10), num(v[200], 20))],
    ignite: [clip(sf[2]), clip(sf[3])],
    ash: [clip(ash[2]), clip(ash[3]), clip(ash[4]), clip(ash[5])],
    ashTime: [num(ash[6], 15), Math.max(num(ash[6], 15), num(ash[7], 25))],
    igniteRange: num(ko[2], 20),
    approach: num(ko[3], 8),
    circleLimit: num(ko[4], 11),
    circleRadius: num(ko[5], 4),
    circle: [ma(ref(v[182])), ma(ref(v[183]))],
    flame: { gen: ref(fk[2]), clip: clip(fk[3]), parts: generatorParts(pkgs, ref(fk[2])) },
    decide: [num(fk[4], 3), Math.max(num(fk[4], 3), num(fk[5], 6))],
    flameBand: [num(fk[6], 0), num(fk[7], 5)],
    ballBand: [num(fk[8], 6), num(fk[9], 30)],
    ballChance: num(fk[10], 90),
    ball: {
      clip: clip(at[0]),
      speed: num(bo?.t?.v[1], 25000) / 2048,
      parts: generatorParts(pkgs, refs(bo?.t?.v[34])[0]),
      boneFrom,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Ranged Targeting Position (class 0x97844105; ctor 0x10126d10, map 0x10179de8) and the
// RangedCombatRepositionBehavior that uses them (Character p98; FindTargettingPosition
// 0x101265c0)

export interface RepositionParams {
  /** p0..p1 stay time (s) before looking for another stand. */
  stay: [number, number];
  /** p2 search radius around itself (m). */
  radius: number;
  /** p3 band-centre, p4 closeness, p5 cover weights. */
  wCentre: number;
  wNear: number;
  wCover: number;
  /** p6 line-of-sight test from the stand, p8 eye bone, p9 margin narrowing the range band (m). */
  sight: boolean;
  bone: number;
  margin: number;
}

export function repositionParams(pkgs: EntityPackageSet, r: ResRef | undefined): RepositionParams | undefined {
  const t = readTemplate(pkgs, r);
  if (t?.cls !== 'RangedCombatRepositionBehavior') return undefined;
  const v = t.v;
  return {
    stay: [num(v[0], 3), Math.max(num(v[0], 3), num(v[1], 8))],
    radius: num(v[2], 30),
    wCentre: num(v[3], -1),
    wNear: num(v[4], 0.5),
    wCover: num(v[5], 1.5),
    sight: num(v[6], 1) !== 0,
    bone: num(v[8], -1),
    margin: num(v[9], 0.75),
  };
}

/** Stand score (0x101265c0): closeness to itself, distance band centre, cover. */
export function standScore(p: RepositionParams, dSelf: number, dTarget: number, band: [number, number], cover: boolean): number {
  const [A, B] = band;
  const mid = (A + B) / 2;
  return p.wNear * (1 - dSelf / Math.max(1e-3, p.radius)) + p.wCentre * (1 - (2 * Math.abs(dTarget - mid)) / Math.max(1e-3, B - A)) + p.wCover * (cover ? 1 : 0);
}

/** Usable target distance band of a ranged attack narrowed by the margin. */
export function standBand(rangeMin: number, rangeMax: number, margin: number): [number, number] {
  const A = Math.max(rangeMin + margin, 0.1);
  return [A, Math.max(rangeMax - margin, A + 0.1)];
}
