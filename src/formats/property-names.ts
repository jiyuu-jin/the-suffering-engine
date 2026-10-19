// Property names recovered by reverse engineering the code that reads each property
// (Suffering.rfl), not from editor data: Unspeakable.rcdx, the editor class file with the real
// names, did not ship. Every name here is backed by the read site listed in
// docs/re/properties.md (RFL addresses) or, where marked there, by unambiguous retail data.
// Names are descriptive, not the original identifiers. entities.ts merges these under its own
// hand-written names (CLASS_NAMES wins on a clash). The "in" / "out" prefixes are kept for
// verified message slots only (entities.ts turns them into input / output slots).

/** Names shared by every class of a base family (merged before the class's own names). */
export const RE_FAMILY_NAMES: Record<string, Record<number, string>> = {
  GameObject: {
    // GameObject p2: Difficulty Modifier (four factors by difficulty) [strong].
    2: 'difficultyModifier',
    // p5 != 0: every damage type not listed in a Damage Resistance attachment is ignored
    // (RFL 0x100a2dc0 [code]).
    5: 'immuneToUnlisted',
  },
};

/** Per-class names, by class name. */
export const RE_CLASS_NAMES: Record<string, Record<number, string>> = {
  'Damage Resistance': { 0: 'damageType', 1: 'multiplier' },

  // Projectile base (Missile and BouncingObject share properties 0..48).
  Missile: projectile(),
  BouncingObject: {
    ...projectile(),
    49: 'settleBounces',
    50: 'anySurfaceBounces',
    51: 'bounceSpeedLossPct',
    54: 'settleFuse',
    60: 'detonateOnCharacter',
  },

  'Radius Damage': {
    0: 'damageCentre',
    1: 'damageEdge',
    2: 'forceCentre',
    3: 'forceEdge',
    4: 'stimulus',
    5: 'radius',
    7: 'hurtsOwner',
    8: 'needsLineOfSight',
    9: 'victimEffect',
    10: 'damageType',
  },

  'Melee Weapon': {
    68: 'damage',
    69: 'force',
    70: 'damageType',
    71: 'swingSounds',
    74: 'hitSounds',
    77: 'materialEffects',
  },

  'Ranged Weapon': {
    64: 'adrenalineTemplate',
    65: 'playerWeaponProps',
    66: 'playerWeaponProps2',
    67: 'upgradeWeapon',
    68: 'ammoItem',
    69: 'clipSize',
    70: 'pickupRounds',
    71: 'automatic',
    75: 'spreadDeg',
    76: 'aimAssistConeDeg',
    77: 'weaponFireClip',
    78: 'projectileBone',
    79: 'fireSounds',
    80: 'muzzleFlashBone',
    81: 'projectileGenerator',
    82: 'muzzleGenerator',
    83: 'muzzleFlash',
    85: 'fireFromMuzzle',
    86: 'casingGenerator',
    87: 'weaponReloadClip',
    88: 'casingBone',
    89: 'ammoMeter',
  },

  'Missile Item': { 55: 'thrownObject', 56: 'hudMeter' },

  Attack: { 0: 'strikeClip', 3: 'recoveryClip', 6: 'damageMult', 7: 'forceMult' },

  Flashlight: {
    55: 'spotLight',
    56: 'spotLight2',
    60: 'decoration',
    61: 'deadBatteryLevel',
    62: 'adaptedBrightnessPct',
    63: 'switchOnBrightnessPct',
    64: 'switchOnFlashPct',
    65: 'adaptOnSeconds',
    66: 'adaptOffSeconds',
    67: 'fullChargeSeconds',
    68: 'dimSeconds',
    69: 'batteryItem',
    70: 'difficultyModifier',
    71: 'hudMeter',
    72: 'hudMeter2',
  },

  'Combat Music': {
    0: 'tracks',
    1: 'startEnemies',
    2: 'startRadius',
    3: 'keepEnemies',
    4: 'keepRadius',
    5: 'lingerSeconds',
    6: 'fadeInSeconds',
    7: 'fadeOutSeconds',
    8: 'replaceFadeSeconds',
    10: 'activeAtStart',
    11: 'inMakeCurrent',
    12: 'replacePlaying',
  },

  'Message Relay': { 2: 'pickCount', 3: 'pickMode' },

  'Damage Action Object': {
    0: 'targetMode',
    1: 'applyMessage',
    2: 'destroyMessage',
    3: 'perSecond',
    4: 'damage',
    5: 'damageType',
    6: 'force',
    7: 'stimulus',
    8: 'targetEffect',
  },

  RootPlayAnimBehavior: { 2: 'clips', 3: 'inOrder', 4: 'playCount', 5: 'timeLimit' },

  HoraceKillPlayerBehavior: {
    2: 'triggerMessage',
    3: 'endMessage',
    4: 'triggerDelayMin',
    5: 'triggerDelayMax',
    6: 'durationMin',
    7: 'durationMax',
  },
};

/** Projectile base properties (RFL 0x100cf8b0 launch, 0x100d1450 impact [code]). */
function projectile(): Record<number, string> {
  return {
    1: 'speed',
    2: 'speedMax',
    12: 'lifetime',
    14: 'impactNoise',
    16: 'fireNoise',
    26: 'damage',
    28: 'forceNear',
    29: 'forceFar',
    30: 'forceNearDist',
    31: 'forceFarDist',
    32: 'damageType',
    34: 'impactGenerators',
    40: 'tracer',
    41: 'materialEffects',
    46: 'gravityPct',
    47: 'gravityRandomPct',
  };
}
