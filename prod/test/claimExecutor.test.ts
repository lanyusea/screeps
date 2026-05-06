import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import type { RuntimeTelemetryEvent } from '../src/telemetry/runtimeSummary';
import {
  clearAutonomousExpansionClaimIntent,
  refreshAutonomousExpansionClaimIntent,
  runRecommendedExpansionClaimExecutor,
  shouldDeferOccupationRecommendationForExpansionClaim
} from '../src/territory/claimExecutor';
import type {
  OccupationRecommendationReport,
  OccupationRecommendationScore
} from '../src/territory/occupationRecommendation';

describe('autonomous expansion claim executor', () => {
  let tickSeed = 10000;
  const nextTick = () => tickSeed++;

  beforeEach(() => {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 1;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 2;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 3;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 4;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { RoomPosition: RoomPositionConstructor }).RoomPosition = class {
      constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly roomName: string
      ) {}
    } as RoomPositionConstructor;
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
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { FIND_MINERALS?: number }).FIND_MINERALS;
    delete (globalThis as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN;
    delete (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
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
        type: 'territoryScout',
        roomName: 'W1N1',
        colony: 'W1N1',
        targetRoom: 'W1N2',
        phase: 'intel',
        result: 'recorded',
        controllerId: 'controller12',
        sourceCount: 1,
        hostileCreepCount: 0,
        hostileStructureCount: 0,
        hostileSpawnCount: 0
      },
      {
        type: 'territoryScout',
        roomName: 'W1N1',
        colony: 'W1N1',
        targetRoom: 'W1N2',
        phase: 'validation',
        result: 'passed',
        controllerId: 'controller12',
        sourceCount: 1,
        hostileCreepCount: 0,
        hostileStructureCount: 0,
        hostileSpawnCount: 0,
        score: evaluation.score
      },
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

  it('uses claimed-room resource synergy when ranking autonomous expansion claims', () => {
    const colony = makeColony({
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_000,
      sourceCount: 2,
      mineralType: 'H'
    });
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>,
      sourceCount: 2,
      mineralType: 'H'
    });
    (Game.rooms as Record<string, Room>).W1N2 = makeTargetRoom('W1N2', {
      controllerId: 'controller12' as Id<StructureController>,
      sourceCount: 1,
      mineralType: 'O'
    });

    const evaluation = refreshAutonomousExpansionClaimIntent(
      colony,
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        }),
        makeCandidate({
          roomName: 'W1N2',
          controllerId: 'controller12' as Id<StructureController>,
          sourceCount: 1
        })
      ]),
      100
    );

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W1N2',
      controllerId: 'controller12'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'claim',
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller12'
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
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutIntel?.['W1N1>W2N1']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      updatedAt: 101,
      controller: { id: 'controller2', my: false },
      sourceCount: 1,
      hostileCreepCount: 0,
      hostileStructureCount: 0,
      hostileSpawnCount: 0
    });
    expect(events).toEqual([
      {
        type: 'territoryScout',
        roomName: 'W1N1',
        colony: 'W1N1',
        targetRoom: 'W2N1',
        phase: 'intel',
        result: 'recorded',
        controllerId: 'controller2',
        sourceCount: 1,
        hostileCreepCount: 0,
        hostileStructureCount: 0,
        hostileSpawnCount: 0
      },
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
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      nextTick()
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

  it('blocks a room already targeted by a same-colony autonomous claim intent', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 105,
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
      makeReport([makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })]),
      nextTick()
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
        status: 'planned',
        updatedAt: 105,
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller2'
      }
    ]);
  });

  it('blocks same-tick autonomous claims for a room already targeted by another colony', () => {
    const firstColony = makeColony({ roomName: 'W1N1', controllerLevel: 4 });
    const secondColony = makeColony({ roomName: 'W3N1', controllerLevel: 4 });
    (Game.rooms as Record<string, Room>) = {
      W1N1: firstColony.room,
      W3N1: secondColony.room,
      W2N1: makeTargetRoom('W2N1', {
        controllerId: 'controller2' as Id<StructureController>
      })
    };
    (Game as { map: GameMap }).map = makeMap({
      W1N1: { '3': 'W2N1' },
      W3N1: { '7': 'W2N1' },
      W2N1: { '7': 'W1N1' }
    });
    const report = makeReport([
      makeCandidate({
        roomName: 'W2N1',
        controllerId: 'controller2' as Id<StructureController>,
        sourceCount: 2
      })
    ]);

    const firstEvaluation = refreshAutonomousExpansionClaimIntent(firstColony, report, 107);
    const secondEvaluation = refreshAutonomousExpansionClaimIntent(secondColony, report, 107);

    expect(firstEvaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1'
    });
    expect(secondEvaluation).toMatchObject({
      status: 'skipped',
      colony: 'W3N1',
      targetRoom: 'W2N1',
      reason: 'existingClaimIntent'
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
    expect(Game.map.describeExits).toHaveBeenCalledTimes(2);
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

  it('creates a scout intent for an unvalidated adjacent claim candidate', () => {
    const events: RuntimeTelemetryEvent[] = [];

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      120,
      events
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'scoutPending'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 120,
        controllerId: 'controller2'
      }
    ]);
    expect(Memory.territory?.scoutAttempts?.['W1N1>W2N1']).toEqual({
      colony: 'W1N1',
      roomName: 'W2N1',
      status: 'requested',
      requestedAt: 120,
      updatedAt: 120,
      attemptCount: 1,
      controllerId: 'controller2',
      lastValidation: {
        status: 'pending',
        reason: 'intelMissing',
        updatedAt: 120
      }
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'territoryScout',
        phase: 'validation',
        result: 'pending',
        reason: 'intelMissing',
        targetRoom: 'W2N1',
        score: evaluation.score
      }),
      expect.objectContaining({
        type: 'territoryScout',
        phase: 'attempt',
        result: 'requested',
        targetRoom: 'W2N1',
        controllerId: 'controller2'
      }),
      expect.objectContaining({
        type: 'territoryClaim',
        phase: 'skip',
        reason: 'scoutPending',
        targetRoom: 'W2N1'
      })
    ]);
  });

  it('passes claim validation from positive scout intel even when the room is no longer visible', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            updatedAt: 130,
            controller: { id: 'controller2' as Id<StructureController>, my: false },
            sourceIds: ['source1', 'source2'],
            sourceCount: 2,
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      131
    );

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
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
  });

  it('requests a fresh scout instead of claiming from expired positive scout intel', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            updatedAt: 100,
            controller: { id: 'controller2' as Id<StructureController>, my: false },
            sourceIds: ['source1', 'source2'],
            sourceCount: 2,
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      1_601
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      reason: 'scoutPending'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutAttempts?.['W1N1>W2N1']).toEqual({
      colony: 'W1N1',
      roomName: 'W2N1',
      status: 'requested',
      requestedAt: 1_601,
      updatedAt: 1_601,
      attemptCount: 1,
      controllerId: 'controller2',
      lastValidation: {
        status: 'pending',
        reason: 'scoutPending',
        updatedAt: 1_601
      }
    });
  });

  it('waits for the active scout request when existing intel predates it', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutAttempts: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'requested',
            requestedAt: 140,
            updatedAt: 140,
            attemptCount: 1,
            controllerId: 'controller2' as Id<StructureController>
          }
        },
        scoutIntel: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            updatedAt: 130,
            controller: { id: 'controller2' as Id<StructureController>, my: false },
            sourceIds: ['source1', 'source2'],
            sourceCount: 2,
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      141
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      reason: 'scoutPending'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutAttempts?.['W1N1>W2N1']).toEqual({
      colony: 'W1N1',
      roomName: 'W2N1',
      status: 'requested',
      requestedAt: 140,
      updatedAt: 141,
      attemptCount: 1,
      controllerId: 'controller2',
      lastValidation: {
        status: 'pending',
        reason: 'scoutPending',
        updatedAt: 141
      }
    });
  });

  it('persists visible negative scout intel before returning a controller-owned skip', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            updatedAt: 130,
            controller: { id: 'controller2' as Id<StructureController>, my: false },
            sourceIds: ['source1', 'source2'],
            sourceCount: 2,
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };
    const visibleRoom = makeTargetRoom('W2N1', {
      controllerId: 'controller2' as Id<StructureController>,
      sourceCount: 1
    });
    const visibleController = visibleRoom.controller as StructureController & { owner?: { username: string } };
    visibleController.owner = { username: 'enemy' };
    (Game.rooms as Record<string, Room>).W2N1 = visibleRoom;

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      150
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      reason: 'controllerOwned'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutIntel?.['W1N1>W2N1']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      updatedAt: 150,
      controller: {
        id: 'controller2',
        my: false,
        ownerUsername: 'enemy'
      },
      sourceCount: 1,
      hostileCreepCount: 0,
      hostileStructureCount: 0,
      hostileSpawnCount: 0
    });
  });

  it('blocks claim validation when scout intel sees a hostile controller', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            updatedAt: 140,
            controller: {
              id: 'controller2' as Id<StructureController>,
              my: false,
              ownerUsername: 'enemy'
            },
            sourceIds: ['source1'],
            sourceCount: 1,
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      141
    );

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      reason: 'controllerOwned'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutAttempts?.['W1N1>W2N1']?.lastValidation).toEqual({
      status: 'blocked',
      reason: 'controllerOwned',
      updatedAt: 141
    });
  });

  it('falls back to a best-effort claim after the scout validation timeout', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutAttempts: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'requested',
            requestedAt: 100,
            updatedAt: 100,
            attemptCount: 1,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };

    const evaluation = refreshAutonomousExpansionClaimIntent(
      makeColony(),
      makeReport([
        makeCandidate({
          roomName: 'W2N1',
          controllerId: 'controller2' as Id<StructureController>,
          sourceCount: 2
        })
      ]),
      1_701
    );

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
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
    expect(Memory.territory?.scoutAttempts?.['W1N1>W2N1']).toMatchObject({
      status: 'timedOut',
      lastValidation: {
        status: 'fallback',
        reason: 'scoutTimeout',
        updatedAt: 1_701
      }
    });
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
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutIntel?.['W1N1>W2N1']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      updatedAt: 103,
      controller: { id: 'controller2', my: false },
      sourceCount: 1
    });
  });

  it('defers the claim while the target controller only has upgradeBlocked cooldown', () => {
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
    expect(Memory.territory?.targets).toBeUndefined();
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
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutIntel?.['W1N1>W2N1']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      updatedAt: 104,
      controller: { id: 'controller2', my: false },
      sourceCount: 1
    });
  });

  it('does not move a recommended claimer toward a visible hostile target room', () => {
    const controllerId = 'controller2' as Id<StructureController>;
    (Game as { time: number }).time = 2_001;
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', {
      controllerId,
      hostileCreeps: [{ id: 'enemy1' } as Creep]
    });
    seedRecommendedClaimMemory({ controllerId, updatedAt: 2_000 });
    const creep = makeRecommendedClaimCreep({ controllerId });

    expect(runRecommendedExpansionClaimExecutor(creep)).toBe(true);

    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 2_001,
        createdBy: 'autonomousExpansionClaim',
        controllerId
      }
    ]);
  });

  it('does not act on a recommended claimer while the claim intent is suspended', () => {
    const controllerId = 'controller2' as Id<StructureController>;
    (Game as { time: number }).time = 2_051;
    seedRecommendedClaimMemory({
      controllerId,
      updatedAt: 2_000,
      suspended: {
        reason: 'hostile_presence',
        hostileCount: 1,
        updatedAt: 2_050
      }
    });
    const creep = makeRecommendedClaimCreep({ controllerId });

    expect(runRecommendedExpansionClaimExecutor(creep)).toBe(true);

    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents?.[0]).toMatchObject({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'active',
      updatedAt: 2_000,
      createdBy: 'autonomousExpansionClaim',
      controllerId,
      suspended: {
        reason: 'hostile_presence',
        hostileCount: 1,
        updatedAt: 2_050
      }
    });
  });

  it('respects fresh suppression for recommended claim intents', () => {
    const controllerId = 'controller2' as Id<StructureController>;
    (Game as { time: number }).time = 2_101;
    (Game.rooms as Record<string, Room>).W2N1 = makeTargetRoom('W2N1', { controllerId });
    seedRecommendedClaimMemory({
      controllerId,
      status: 'suppressed',
      updatedAt: 2_100
    });
    const creep = makeRecommendedClaimCreep({ controllerId });

    expect(runRecommendedExpansionClaimExecutor(creep)).toBe(true);

    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 2_100,
        createdBy: 'autonomousExpansionClaim',
        controllerId
      }
    ]);
  });
});

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;
type MockClaimCreep = Creep & {
  moveTo: jest.Mock;
  claimController: jest.Mock;
  memory: CreepMemory & { territory?: CreepTerritoryMemory };
};

function makeColony({
  roomName = 'W1N1',
  energyAvailable = 650,
  energyCapacityAvailable = 650,
  controllerLevel = 3,
  sourceCount = 1,
  mineralType
}: {
  roomName?: string;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  controllerLevel?: number;
  sourceCount?: number;
  mineralType?: string;
} = {}): ColonySnapshot {
  const room = {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    controller: { my: true, owner: { username: 'me' }, level: controllerLevel, ticksToDowngrade: 10_000 },
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return Array.from({ length: sourceCount }, (_value, index) => ({ id: `${roomName}-source${index}` }));
      }

      if (type === FIND_MINERALS) {
        return mineralType
          ? [
              {
                id: `${roomName}-mineral`,
                mineralType,
                density: 1
              }
            ]
          : [];
      }

      return [];
    })
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
    sourceCount = 1,
    mineralType = 'H',
    hostileCreeps = [],
    hostileStructures = []
  }: {
    controllerId: Id<StructureController>;
    upgradeBlocked?: number;
    sourceCount?: number;
    mineralType?: string;
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
    } as StructureController & { upgradeBlocked?: number },
    find: jest.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
      }

      if (type === FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      if (type === FIND_SOURCES) {
        return Array.from({ length: sourceCount }, (_value, index) => ({ id: `${roomName}-source${index}` }));
      }

      if (type === FIND_MINERALS) {
        return mineralType
          ? [
              {
                id: `${roomName}-mineral`,
                mineralType
              }
            ]
          : [];
      }

      return [];
    })
  } as unknown as Room;
}

function seedRecommendedClaimMemory(intent: Partial<TerritoryIntentMemory> = {}): void {
  const controllerId = intent.controllerId ?? ('controller2' as Id<StructureController>);
  (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
    territory: {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'claim',
          createdBy: 'autonomousExpansionClaim',
          controllerId
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'active',
          updatedAt: 2_000,
          createdBy: 'autonomousExpansionClaim',
          controllerId,
          ...intent
        }
      ]
    }
  };
}

function makeRecommendedClaimCreep({
  controllerId = 'controller2' as Id<StructureController>,
  room = { name: 'W1N1' } as Room
}: {
  controllerId?: Id<StructureController>;
  room?: Room;
} = {}): MockClaimCreep {
  return {
    name: 'Claimer1',
    memory: {
      role: 'claimer',
      colony: 'W1N1',
      territory: {
        targetRoom: 'W2N1',
        action: 'claim',
        controllerId
      }
    },
    room,
    moveTo: jest.fn(),
    claimController: jest.fn()
  } as unknown as MockClaimCreep;
}

function makeMap(exitsByRoom: Record<string, Partial<Record<'1' | '3' | '5' | '7', string>>>): GameMap {
  return {
    describeExits: jest.fn((roomName: string) => exitsByRoom[roomName] ?? {})
  } as unknown as GameMap;
}
