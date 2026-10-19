// Registry of the game classes the actors system handles, keyed by class name (the names
// of src/formats/entity-classes.ts). It is the single place that says which placed classes
// belong to this system, how, and how faithfully (docs/game-logic.md §15; tools/coverage.ts
// counts a class as handled when its name appears in engine code, so every class handled
// generically - by model, template behaviours and clips - is listed here explicitly).
//
//   role       'character'  placed / cloned Character (actor.ts + manager.ts)
//              'logic'      level-logic class driving actors (director.ts)
//              'behavior'   root / sub behaviour object or template (behaviors.ts)
//              'marker'     position object read by other classes
//              'none'       placed but nothing to do in the port (reason in `notes`)
//   fidelity   'verified'   read from the Suffering.rfl class code (message map / handlers)
//              'data'       follows from how every chapter-1 instance is wired
//              'inferred'   behaviour reconstructed from clips / templates, not the code

export type ActorClassRole = 'character' | 'logic' | 'behavior' | 'marker' | 'none';
export type Fidelity = 'verified' | 'data' | 'inferred';

export interface ActorClassInfo {
  role: ActorClassRole;
  fidelity: Fidelity;
  notes: string;
}

const C = (fidelity: Fidelity, notes: string): ActorClassInfo => ({ role: 'character', fidelity, notes });
const L = (fidelity: Fidelity, notes: string): ActorClassInfo => ({ role: 'logic', fidelity, notes });
const B = (fidelity: Fidelity, notes: string): ActorClassInfo => ({ role: 'behavior', fidelity, notes });

export const ACTOR_CLASSES: Readonly<Record<string, ActorClassInfo>> = {
  // --- Characters (all share the Character slots of §15.1; per-class code is in the RFL) ---
  'Unspeakable NPC': C('data', 'guards / prisoners: Idle + KillEnemies (guards shoot creatures), conversations, waypoints, corpses'),
  'CartWheeler': C('verified', 'the Slayer: crawls ceilings over ceiling Move Nodes, lets go / leaps up at transition edges, slashes from the ceiling, leaps at its prey, behaviour variants by condition (specials/cartwheeler.ts)'),
  'Slayer': C('data', 'ranged creature: Ranged Weapon (p52) bullets, ProjectileAttackBehavior firing clips, keeps its distance'),
  'Rat': C('inferred', 'swarm creature: RatSpawnBehavior emerge clip (p2) then the cloner-relayed behaviour; FallBehavior drop-ins (1b hatch)'),
  'Nooseman': C('verified', 'hidden between attacks; drops on its rope at a Drop Position of its group (p185) above the player, grabs and strangles (specials/nooseman.ts)'),
  'Mainliner': C('verified', 'melee + thrown needles (Missile in p55, ProjectileAttackBehavior); jump attack and ride on the player (specials/mainliner.ts)'),
  'Fester': C('verified', 'melee creature; charge attack, rat release, bullet-proof except its open weak spot (specials/fester.ts)'),
  'Burrower': C('verified', 'melee creature travelling underground (untargetable), fly-by passes, surfaces to strike (specials/burrower.ts)'),
  'Horace': C('verified', 'scripted ghost: Idle / STOMP poses, electric arcs (Damage Action Object); the 1a fight runs HoraceKillPlayerBehavior stages (specials/horace.ts)'),
  'Hermes': C('data', 'scripted ghost: Idle / STOMP poses'),
  'Killjoy': C('verified', 'no attacks; scripted appearances, and in 5b KilljoyRootBehavior: flees, raises dead CartWheelers, dies with his projectors (specials/killjoy.ts)'),
  'Inferna': C('verified', 'burning creature: ignites, circles, flame bursts / fireballs, hurt only as an ash pile (specials/inferna.ts)'),
  'Black One': C('verified', 'final boss of 10 Docks: Ground Object placed by specials/black-one.ts (shared heart, three stages, teleports); Died p76 starts the ending'),
  // --- Level logic (director.ts) ---
  'Behavior Changer': L('verified', 'message map p11..p15, p2 uses, p3 drop dead links; p5..p8 behaviours, p17 chain-done output [data]'),
  'Object Cloner': L('verified', 'creature spawner: counts, limits, intervals, distance band, off-screen test, outputs p15..p18'),
  'Speech Player': L('verified', 'start / finish code: linked speaker, p5 sounds, p8 / p9 outputs; subtitles + lip-sync'),
  'Action Dialog': L('verified', 'message map p24..p28 [verified]; bark lists and chances [inferred]'),
  'Damage Action Object': L('verified', 'p4 damage (p3 per second), p8 effect on the target, targets by p0 [data]'),
  'EdgeToggler': L('verified', 'two linked Move Nodes = one nav edge; p0 enabled at start, input p1 enables, p2 disables'),
  'Aim Controller': L('data', 'turns its Animating Static (p9; 1a caged CartWheelers) toward the targets (p14) within +-p5 at p18 deg/s; On p27 / Off p28 / Destroy p29'),
  'Ambient Creature': L('verified', 'vermin (PhysicalObject, 1 health): p24 run loop at p25 m/s along an Ambient Creature Waypoint network on On (p32), Off p33, Destroy p12; p28 sounds every p29..p30 s; killed: p26 reputation, p18 break'),
  // --- Behaviour objects / templates (behaviors.ts) ---
  'WaypointBehavior': B('data', 'walk the Waypoint chain, escort wait (p8..p10)'),
  'SimpleConversationBehavior': B('verified', 'p0 / p1 listener [verified]; Line of Dialog lists, ranges and done message [data]'),
  'RootPlayAnimBehavior': B('verified', 'p2 clips (p3 in order / random), done after p4 clips or p5 s (neither: loops until replaced); the clip root motion moves the actor'),
  'KillEnemiesBehavior': B('verified', 'teams / targets / sight; target score, choice and re-pick timing (targeting.ts)'),
  'HostilityBehavior': B('verified', 'restarts its KillEnemies p3..p4 s after one found nothing (targeting.ts); p2 fight sub-behaviours not applied'),
  'IdleBehavior': B('data', 'idle clip + fidgets'),
  'DormantBehavior': B('data', 'hidden / posed until woken'),
  'JumpBehavior': B('data', 'launch / airborne / landing clips'),
  'FallBehavior': B('data', 'falling clip until it lands'),
  'JumpAttackBehavior': B('verified', 'the CartWheeler leap: launch Attack root motion, stick or miss (specials/cartwheeler.ts); other users plain hostile combat'),
  'MainlinerJumpAttackBehavior': B('verified', 'placed root behaviour (level 2 #870): the Mainliner leaps at once (specials/mainliner.ts)'),
  'CeilingFloorTransitionBehavior': B('verified', 'CartWheeler ceiling <-> floor: let go / fall / land, launch / fly up / catch (specials/cartwheeler.ts)'),
  'KilljoyRootBehavior': B('verified', 'p2 corpses Killjoy raises (specials/killjoy.ts)'),
  'DeathBehavior': B('data', 'death clips; placed corpses; scripted deaths'),
  'FleeBehavior': B('verified', 'run to the best Flee Position of its group (away from threats, near allies), re-pick while standing (flee.ts)'),
  'RatSpawnBehavior': B('inferred', 'p2 emerge clip played once, then the active behaviour'),
  'HoraceKillPlayerBehavior': B('verified', 'p2 / p3 message ids (Triggered out, QuestStart in), p4..p7 delays; staged volleys (specials/horace.ts)'),
  'OpenDoorBehavior': B('data', 'p2 / p3 push clips; creatures open Edge Passage doors through the Switch'),
  'ProjectileAttackBehavior': B('data', 'Attack templates (p0 firing clip), p19..p20 seconds between shots'),
  // --- Markers ---
  'Waypoint': { role: 'marker', fidelity: 'data', notes: 'p0 arrival message, p2 speed, p5 radius; links = next waypoint' },
  'Ambient Creature Waypoint': { role: 'marker', fidelity: 'data', notes: 'p0 / p1 stop-and-play clips' },
  'Nooseman Drop Position': { role: 'marker', fidelity: 'data', notes: 'drop group root linking to the other positions' },
  'Flee Position': { role: 'marker', fidelity: 'verified', notes: 'FleeBehavior spots; linked ones form a group, p0 height limit' },
  'Move Node Object': { role: 'marker', fidelity: 'data', notes: 'navigation graph (nav.ts)' },
  // --- Nothing to do in chapter 1 ---
  'Companion Spawn Point': {
    role: 'none',
    fidelity: 'verified',
    notes: 'arrival point for a follower carried through a Level Transition (no message map, one output p4); chapter 1 has no follower',
  },
  'Ranged Targeting Position': { role: 'marker', fidelity: 'verified', notes: 'shooting stands picked by RangedCombatRepositionBehavior (p98) users (specials/ranged-positions.ts)' },
  'Teleport Pad': { role: 'marker', fidelity: 'verified', notes: 'where a Black One teleport missile puts the player (specials/black-one.ts)' },
  'Projector Effect': L('verified', 'projected Killjoy: opacity by surviving projectors, 10000 damage when all are broken (specials/killjoy.ts)'),
};

/** Character classes the actors system creates actors for. */
export const CHARACTER_CLASSES = new Set(Object.entries(ACTOR_CLASSES).filter(([, v]) => v.role === 'character').map(([k]) => k));

export function actorClass(name: string): ActorClassInfo | undefined {
  return ACTOR_CLASSES[name];
}
