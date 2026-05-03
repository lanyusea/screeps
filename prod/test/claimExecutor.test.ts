import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import type { RuntimeTelemetryEvent } from '../src/telemetry/runtimeSummary';
import {
  clearAutonomousExpansionClaimIntent,
  refreshAutonomousExpansionClaimIntent,
  shouldDeferOccupationRecommendationForExpansionClaim
} from '../src/territory/claimExecutor';
import type {
  OccupationRecommendationReport,
  OccupationRecommendationScore
} from '../src/territory/occupationRecommendation';

describe('autonomous expansion claim executor', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 1;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {},
      map: makeMap({
        W1N1: { '1': 'W1N2', '3': 'W2N1' },
        W1N2: { '5': 'W1N1' },
        W2N1: { '7': 'W1N1' }
      })
    };
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
  });

  it('records a claim intent for the best expansion-scored adjacent room above threshold', () => {
    const colony = makeColony();
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>
    });
    (Game.rooms as Record<string, Room>).W1N2 = makeTargetRoom('W1N2', {
      controllerId: 'controller12' as Id<StructureController>
    });
    const events: RuntimeTelemetryEvent[] = [];

    const evaluation = refreshAutonomousExpansionClaimIntent(
      colony,
      makeReport([
        makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> }),
        makeCandidate({
          roomName: 'W1N2',
          controllerId: 'controller12' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      100,
      events
    );

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W1N2',
      controllerId: 'controller12'
    });
    expect(evaluation.score).toBeGreaterThan(300);
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'claim',
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller12'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'claim',
        status: 'planned',
        updatedAt: 100,
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller12'
      }
    ]);
    expect(events).toEqual([
      {
        type: 'territoryClaim',
        roomName: 'W1N1',
        colony: 'W1N1',
        phase: 'intent',
        targetRoom: 'W1N2',
        controllerId: 'controller12',
        score: evaluation.score
      }
    ]);
  });

  it('does not record a claim when all expansion scores are below threshold', () => {
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>
    });
    const events: RuntimeTelemetryEvent[] = [];

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: null
        })
      ]),
      101,
      events
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      reason: 'scoreBelowThreshold'
    });
    expect(evaluation.score).toBeLessThanOrEqual(500);
    expect(Memory.territory).toBeUndefined();
    expect(events).toEqual([
      {
        type: 'territoryClaim',
        roomName: 'W1N1',
        colony: 'W1N1',
        phase: 'skip',
        targetRoom: 'W2N1',
        controllerId: 'controller2',
        score: evaluation.score
      }
    ]);
  });

  it('does not create a duplicate claim when an intent already exists for the room', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'active',
            updatedAt: 105,
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>
    });

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      106
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'existingClaimIntent'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'active',
        updatedAt: 105,
        controllerId: 'controller2'
      }
    ]);
  });

  it('does not record a claim when colony claim resources are insufficient', () => {
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>
    });
    const events: RuntimeTelemetryEvent[] = [];

    const lowEnergyEvaluation = refreshAutonomousExpansionClaimIntent(
      makeColony({ energyCapacityAvailable: 600 }),
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      102,
      events
    );

    expect(lowEnergyEvaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'energyCapacityLow'
    });
    expect(Memory.territory).toBeUndefined();
    expect(events).toContainEqual({
      type: 'territoryClaim',
      roomName: 'W1N1',
      colony: 'W1N1',
      phase: 'skip',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      reason: 'energyCapacityLow',
      score: lowEnergyEvaluation.score
    });

    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const lowRclEvaluation = refreshAutonomousExpansionClaimIntent(
      makeColony({ controllerLevel: 1 }),
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      103
    );

    expect(lowRclEvaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'controllerLevelLow'
    });
    expect(Memory.territory).toBeUndefined();
  });

  it('does not record a claim when no adjacent scoring candidate exists', () => {
    const events: RuntimeTelemetryEvent[] = [];

    const evaluation = refreshAutonomousExpansionClaimIntent(makeColony(), makeReport([]), 101, events);

    expect(evaluation).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'noAdjacentCandidate'
    });
    expect(Memory.territory).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('keeps an existing autonomous claim target when scoring reports it as configured', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'claim',
            createdBy: 'autonomousExpansionClaim',
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>
    });

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          source: 'configured',
          action: 'occupy'
        })
      ]),
      104
    );

    expect(evaluation).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 104,
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller2'
      }
    ]);
  });

  it('keeps non-autonomous claim intents when autonomous claims are cleared', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'claim',
            createdBy: 'autonomousExpansionClaim',
            controllerId: 'controller2' as Id<StructureController>
          }
        ],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 105,
            createdBy: 'autonomousExpansionClaim',
            controllerId: 'controller2' as Id<StructureController>
          },
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 104,
            controllerId: 'controller2' as Id<StructureController>
          },
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 103,
            createdBy: 'occupationRecommendation',
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };

    clearAutonomousExpansionClaimIntent('W1N1');

    expect(Memory.territory?.targets).toEqual([]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 104,
        controllerId: 'controller2'
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 103,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2'
      }
    ]);
  });

  it('defers the reserve fallback while the target controller is on cooldown', () => {
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>,
      upgradeBlocked: 25
    });

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      103
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'controllerCooldown'
    });
    expect(shouldDeferOccupationRecommendationForExpansionClaim(evaluation)).toBe(true);
    expect(Memory.territory).toBeUndefined();
  });

  it('marks and emits a gclInsufficient skip when GCL room cap is reached', () => {
    const colony = makeColony();
    const firstOwnedRoom = makeTargetRoom('W3N1', {
      controllerId: 'controller3' as Id<StructureController>
    });
    const secondOwnedRoom = makeTargetRoom('W4N1', {
      controllerId: 'controller4' as Id<StructureController>
    });
    const ownedController = firstOwnedRoom.controller as StructureController;
    ownedController.my = true;
    ownedController.owner = { username: 'me' };
    const secondOwnedController = secondOwnedRoom.controller as StructureController;
    secondOwnedController.my = true;
    secondOwnedController.owner = { username: 'me' };
    (Game.rooms as Record<string, Room>) = {
      W1N1: colony.room,
      W3N1: firstOwnedRoom,
      W4N1: secondOwnedRoom,
      W2N1: makeTargetRoom('W2N1', {
        controllerId: 'controller2' as Id<StructureController>
      })
    };
    (Game as { gcl: { level: number } }).gcl = { level: 3 };

    const evaluation = refreshAutonomousExpansionClaimIntent(
      colony,
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      104
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'gclInsufficient'
    });
    expect(shouldDeferOccupationRecommendationForExpansionClaim(evaluation)).toBe(false);
    expect(Memory.territory).toBeUndefined();
  });
});

function makeColony({
  energyAvailable = 650,
  energyCapacityAvailable = 650,
  controllerLevel = 3
}: {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  controllerLevel?: number;
} = {}): ColonySnapshot {
  const room = {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable,
    controller: { my: true, owner: { username: 'me' }, level: controllerLevel, ticksToDowngrade: 10_000 }
  } as unknown as Room;

  return {
    room,
    spawns: [],
    energyAvailable,
    energyCapacityAvailable
  };
}

function makeReport(candidates: OccupationRecommendationScore[]): OccupationRecommendationReport {
  return {
    candidates,
    next: candidates[0] ?? null,
    followUpIntent: null
  };
}

function makeCandidate({
  roomName,
  controllerId,
  source = 'adjacent',
  action = 'reserve',
  sourceCount = 1
}: {
  roomName: string;
  controllerId?: Id<StructureController>;
  source?: OccupationRecommendationScore['source'];
  action?: OccupationRecommendationScore['action'];
  sourceCount?: number | null;
}): OccupationRecommendationScore {
  return {
    roomName,
    action,
    score: 1_200,
    evidenceStatus: 'sufficient',
    source,
    evidence: ['room visible', 'controller is available', '1 sources visible'],
    preconditions: [],
    risks: [],
    routeDistance: 1,
    roadDistance: 1,
    ...(typeof sourceCount === 'number' ? { sourceCount } : {}),
    ...(controllerId ? { controllerId } : {})
  };
}

function makeTargetRoom(
  roomName: string,
  {
    controllerId,
    upgradeBlocked = 0,
    hostileCreeps = [],
    hostileStructures = []
  }: {
    controllerId: Id<StructureController>;
    upgradeBlocked?: number;
    hostileCreeps?: Creep[];
    hostileStructures?: AnyStructure[];
  }
): Room {
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my: false,
      ...(upgradeBlocked > 0 ? { upgradeBlocked } : {})
    } as StructureController,
    find: jest.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
      }

      if (type === FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeMap(exitsByRoom: Record<string, Partial<Record<'1' | '3' | '5' | '7', string>>>): GameMap {
  return {
    describeExits: jest.fn((roomName: string) => exitsByRoom[roomName] ?? {})
  } as unknown as GameMap;
}
