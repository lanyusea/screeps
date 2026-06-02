import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { TERRITORY_CONTROLLER_BODY_COST } from '../src/spawn/bodyTemplates';
import {
  getExpansionTriggerRequiredEnergy,
  refreshAutonomousExpansionPipeline
} from '../src/territory/expansionTrigger';
import type {
  ExpansionCandidateReport,
  ExpansionCandidateScore
} from '../src/territory/expansionScoring';

describe('autonomous expansion trigger pipeline', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy' as ResourceConstant;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { FIND_MINERALS?: number }).FIND_MINERALS;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
    delete (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
    delete (globalThis as { TERRITORY_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY?: number })
      .TERRITORY_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY;
    delete (globalThis as { TERRITORY_EXPANSION_TRIGGER_SCORE_THRESHOLD?: number })
      .TERRITORY_EXPANSION_TRIGGER_SCORE_THRESHOLD;
    delete (globalThis as { TERRITORY_EXPANSION_TRIGGER_MIN_RCL?: number }).TERRITORY_EXPANSION_TRIGGER_MIN_RCL;
  });

  it('keeps the RCL 3 expansion energy threshold within room capacity', () => {
    expect(getExpansionTriggerRequiredEnergy(3)).toBe(800);
  });

  it('starts an RCL5 pipeline when room energy reaches the capped threshold', () => {
    const threshold = getExpansionTriggerRequiredEnergy(5);
    expect(threshold).toBe(1_050);
    const colony = makeColony({
      storageEnergy: 2_000,
      rcl: 5,
      energyAvailable: threshold,
      energyCapacityAvailable: 1800
    });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 9,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };
    setSafeHomeThreat('W1N1', 9);

    expect(refreshAutonomousExpansionPipeline(colony, report, 9)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'active',
      stage: 'reserving',
      targetRoom: 'W2N1'
    });
  });

  it('starts a Seasonal RCL3 pipeline when room energy reaches the RCL3 threshold', () => {
    const threshold = getExpansionTriggerRequiredEnergy(3);
    expect(threshold).toBe(800);
    const colony = makeColony({
      storageEnergy: 2_000,
      rcl: 3,
      energyAvailable: threshold,
      energyCapacityAvailable: 800
    });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    const targetRoom = makeTargetRoom('W2N1', 'controller2' as Id<StructureController>);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 9,
      shard: { name: 'shardSeason', type: 'normal' } as Game['shard'],
      rooms: {
        W1N1: colony.room,
        W2N1: targetRoom
      }
    };
    setSafeHomeThreat('W1N1', 9);

    expect(refreshAutonomousExpansionPipeline(colony, report, 9)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'active',
      stage: 'reserving',
      targetRoom: 'W2N1'
    });

    targetRoom.controller = {
      ...targetRoom.controller,
      reservation: { username: 'me', ticksToEnd: 4_000 }
    } as StructureController;

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 10)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.targets?.[0]).toMatchObject({
      roomName: 'W2N1',
      action: 'claim',
      postClaimBootstrapReserveEnergy: 800 - TERRITORY_CONTROLLER_BODY_COST
    });
    expect(
      TERRITORY_CONTROLLER_BODY_COST + (Memory.territory?.targets?.[0]?.postClaimBootstrapReserveEnergy ?? 0)
    ).toBeLessThanOrEqual(800);
  });

  it('keeps the persistent RCL3 pipeline blocked at the default control gate', () => {
    const threshold = getExpansionTriggerRequiredEnergy(3);
    const colony = makeColony({
      storageEnergy: 2_000,
      rcl: 3,
      energyAvailable: threshold,
      energyCapacityAvailable: 800
    });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 9,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };
    setSafeHomeThreat('W1N1', 9);

    expect(refreshAutonomousExpansionPipeline(colony, report, 9)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.expansionPipelines ?? {}).toEqual({});
  });

  it('waits at RCL5 when room energy is below the capped threshold', () => {
    const threshold = getExpansionTriggerRequiredEnergy(5);
    const colony = makeColony({
      storageEnergy: 2_000,
      rcl: 5,
      energyAvailable: threshold - 1,
      energyCapacityAvailable: 1800
    });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 9,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };
    setSafeHomeThreat('W1N1', 9);

    expect(refreshAutonomousExpansionPipeline(colony, report, 9)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.expansionPipelines).toEqual({});
  });

  it('does not start controller-control expansion before RCL5', () => {
    (globalThis as { TERRITORY_EXPANSION_TRIGGER_MIN_RCL?: number }).TERRITORY_EXPANSION_TRIGGER_MIN_RCL = 4;
    const threshold = getExpansionTriggerRequiredEnergy(5);
    const colony = makeColony({
      storageEnergy: 2_000,
      rcl: 4,
      energyAvailable: threshold,
      energyCapacityAvailable: 1800
    });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 9,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };
    setSafeHomeThreat('W1N1', 9);

    expect(refreshAutonomousExpansionPipeline(colony, report, 9)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.expansionPipelines).toEqual({});
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it('gates the trigger on configured storage energy before starting the reserve stage', () => {
    (globalThis as { TERRITORY_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY?: number })
      .TERRITORY_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY = 1_000;
    const colony = makeColony({ storageEnergy: 999 });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 10,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };
    setSafeHomeThreat('W1N1', 10);

    expect(refreshAutonomousExpansionPipeline(colony, report, 10)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.expansionPipelines).toEqual({});

    colony.room.storage = makeStorage(1_000);

    expect(refreshAutonomousExpansionPipeline(colony, report, 11)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'active',
      stage: 'reserving',
      targetRoom: 'W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller2'
      }
    ]);
  });

  it('requires recent defense threat intelligence before starting a pipeline', () => {
    const colony = makeColony({ storageEnergy: 2_000 });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 10,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };

    expect(refreshAutonomousExpansionPipeline(colony, report, 10)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });

    setSafeHomeThreat('W1N1', 4);

    expect(refreshAutonomousExpansionPipeline(colony, report, 10)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });

    setSafeHomeThreat('W1N1', 10);

    expect(refreshAutonomousExpansionPipeline(colony, report, 10)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
  });

  it('does not overwrite invalid territory memory records', () => {
    const invalidTerritory = [] as unknown as TerritoryMemory;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: invalidTerritory
    };
    setSafeHomeThreat('W1N1', 10);
    const colony = makeColony({ storageEnergy: 2_000 });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 10,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };

    expect(refreshAutonomousExpansionPipeline(colony, report, 10)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unavailable'
    });
    expect(Memory.territory).toBe(invalidTerritory);
  });

  it('resumes scout, reserve, claim, and bootstrap stages from memory', () => {
    (globalThis as { TERRITORY_EXPANSION_TRIGGER_SCORE_THRESHOLD?: number })
      .TERRITORY_EXPANSION_TRIGGER_SCORE_THRESHOLD = 100;
    const colony = makeColony({ storageEnergy: 2_000 });
    const report = makeReport([
      makeCandidate({
        roomName: 'W2N1',
        evidenceStatus: 'insufficient-evidence',
        visible: false,
        controllerId: null
      })
    ]);
    const targetRoom = makeTargetRoom('W2N1', 'controller2' as Id<StructureController>);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 20,
      rooms: {
        W1N1: colony.room
      }
    };
    setSafeHomeThreat('W1N1', 20);

    expect(refreshAutonomousExpansionPipeline(colony, report, 20)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      stage: 'scouting',
      status: 'active'
    });
    expect(Memory.territory?.scoutAttempts?.['W1N1>W2N1']).toMatchObject({
      status: 'requested',
      updatedAt: 20
    });

    (Game.rooms as Record<string, Room>).W2N1 = targetRoom;

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 21)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      stage: 'reserving',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.targets?.[0]).toMatchObject({
      roomName: 'W2N1',
      action: 'reserve'
    });

    targetRoom.controller = {
      ...targetRoom.controller,
      reservation: { username: 'me', ticksToEnd: 4_000 }
    } as StructureController;

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 22)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      stage: 'claiming',
      reservationConfirmedAt: 22
    });
    expect(Memory.territory?.targets?.[0]).toMatchObject({
      roomName: 'W2N1',
      action: 'claim',
      postClaimBootstrapReserveEnergy: 400
    });

    targetRoom.controller = {
      id: 'controller2' as Id<StructureController>,
      my: true,
      owner: { username: 'me' }
    } as StructureController;

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 23)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      stage: 'bootstrapping',
      claimedAt: 23
    });
    expect(Memory.territory?.postClaimBootstraps?.W2N1).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      status: 'detected'
    });

    if (Memory.territory?.postClaimBootstraps?.W2N1) {
      Memory.territory.postClaimBootstraps.W2N1.status = 'ready';
    }

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 24)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'noCandidate'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'completed',
      completedAt: 24
    });
  });

  it('aborts an active pipeline when the home downgrade guard is breached', () => {
    const colony = makeColony({ storageEnergy: 2_000, ticksToDowngrade: 5_000 });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        expansionPipelines: {
          W1N1: {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            status: 'active',
            stage: 'reserving',
            score: 900,
            threshold: 700,
            startedAt: 40,
            updatedAt: 40,
            controllerId: 'controller2' as Id<StructureController>
          }
        },
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'reserve',
            createdBy: 'nextExpansionScoring',
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };
    setSafeHomeThreat('W1N1', 40);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 40,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 40)).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'aborted',
      abortReason: 'homeUnstable',
      abortedAt: 40
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
  });

  it('aborts active expansion pipelines before RCL5 and clears persisted control plans', () => {
    const colony = makeColony({ storageEnergy: 2_000, rcl: 4, energyCapacityAvailable: 1800 });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        expansionPipelines: {
          W1N1: {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            status: 'active',
            stage: 'claiming',
            score: 900,
            threshold: 700,
            startedAt: 40,
            updatedAt: 40,
            controllerId: 'controller2' as Id<StructureController>
          }
        },
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'claim',
            createdBy: 'nextExpansionScoring',
            controllerId: 'controller2' as Id<StructureController>
          }
        ],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 40,
            createdBy: 'nextExpansionScoring',
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };
    setSafeHomeThreat('W1N1', 40);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 41,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 41)).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'aborted',
      abortReason: 'controllerLevelGate',
      abortedAt: 41
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
    expect(Memory.territory?.intents).toBeUndefined();
    expect(Memory.territory?.expansionReevaluations?.['W1N1>W2N1']).toMatchObject({
      reason: 'controllerLevelGate',
      updatedAt: 41
    });
  });

  it('preserves a legacy RCL6 gate abort reason when normalizing persisted pipeline memory', () => {
    const colony = makeColony({ storageEnergy: 2_000 });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        expansionPipelines: {
          W1N1: {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            status: 'active',
            stage: 'reserving',
            score: 900,
            threshold: 700,
            startedAt: 40,
            updatedAt: 40,
            controllerId: 'controller2' as Id<StructureController>,
            abortReason: 'rcl6Gate'
          }
        }
      }
    };
    setSafeHomeThreat('W1N1', 42);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 42,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 42)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'active',
      abortReason: 'rcl6Gate',
      updatedAt: 42
    });
  });

  it('blocks new pipelines while claim work is already in flight', () => {
    const colony = makeColony({ storageEnergy: 2_000 });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 50,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>),
        W3N1: makeTargetRoom('W3N1', 'controller3' as Id<StructureController>)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W3N1',
            action: 'claim'
          }
        ]
      }
    };
    setSafeHomeThreat('W1N1', 50);

    expect(refreshAutonomousExpansionPipeline(colony, report, 50)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions',
      reasonDetail: 'activeClaimTarget'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toBeUndefined();

    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'claim',
            status: 'active',
            updatedAt: 50
          }
        ]
      }
    };
    setSafeHomeThreat('W1N1', 50);

    expect(refreshAutonomousExpansionPipeline(colony, report, 50)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions',
      reasonDetail: 'activeClaimIntent'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toBeUndefined();
  });

  it('self-heals completed E29N56 and E29N57 claim intents before the next E29N55 expansion', () => {
    const gameTime = 1_708_611;
    const colony = makeColony({ roomName: 'E29N55', storageEnergy: 2_000, rcl: 6 });
    const report = makeReport([
      makeCandidate({ roomName: 'E29N58', controllerId: 'controller-e29n58' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        expansionPipelines: {},
        intents: [
          {
            colony: 'E29N55',
            targetRoom: 'E29N56',
            action: 'claim',
            status: 'active',
            updatedAt: 1_218_191
          },
          {
            colony: 'E29N55',
            targetRoom: 'E29N57',
            action: 'claim',
            status: 'active',
            updatedAt: 1_218_674
          }
        ],
        postClaimBootstraps: {
          E29N56: makePostClaimBootstrap('E29N55', 'E29N56', 'ready'),
          E29N57: makePostClaimBootstrap('E29N55', 'E29N57', 'completed')
        } as unknown as Record<string, TerritoryPostClaimBootstrapMemory>
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: gameTime,
      gcl: { level: 5 } as GlobalControlLevel,
      rooms: {
        E29N55: colony.room,
        E29N56: makeTargetRoom('E29N56', 'controller-e29n56' as Id<StructureController>, { my: true }),
        E29N57: makeTargetRoom('E29N57', 'controller-e29n57' as Id<StructureController>, { my: true }),
        E29N58: makeTargetRoom('E29N58', 'controller-e29n58' as Id<StructureController>)
      }
    };
    setSafeHomeThreat('E29N55', gameTime);

    expect(refreshAutonomousExpansionPipeline(colony, report, gameTime)).toMatchObject({
      status: 'planned',
      colony: 'E29N55',
      targetRoom: 'E29N58',
      controllerId: 'controller-e29n58'
    });
    expect(Memory.territory?.intents).toEqual([
      expect.objectContaining({
        colony: 'E29N55',
        targetRoom: 'E29N58',
        action: 'reserve',
        status: 'planned'
      })
    ]);
    expect(Memory.territory?.intents?.some((intent) => intent.targetRoom === 'E29N56')).toBe(false);
    expect(Memory.territory?.intents?.some((intent) => intent.targetRoom === 'E29N57')).toBe(false);
    expect(Memory.territory?.expansionPipelines?.E29N55).toMatchObject({
      status: 'active',
      stage: 'reserving',
      targetRoom: 'E29N58'
    });
  });

  it('keeps visible unowned ready-bootstrap recovery claims blocking expansion', () => {
    const gameTime = 1_708_612;
    const colony = makeColony({ roomName: 'E29N55', storageEnergy: 2_000, rcl: 6 });
    const report = makeReport([
      makeCandidate({ roomName: 'E29N58', controllerId: 'controller-e29n58' as Id<StructureController> })
    ]);
    const recoveryTarget = {
      colony: 'E29N55',
      roomName: 'E29N56',
      action: 'claim' as const
    };
    const recoveryIntent = {
      colony: 'E29N55',
      targetRoom: 'E29N56',
      action: 'claim' as const,
      status: 'active' as const,
      updatedAt: 1_218_191
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        expansionPipelines: {},
        targets: [recoveryTarget],
        intents: [recoveryIntent],
        postClaimBootstraps: {
          E29N56: makePostClaimBootstrap('E29N55', 'E29N56', 'ready')
        } as unknown as Record<string, TerritoryPostClaimBootstrapMemory>
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: gameTime,
      gcl: { level: 5 } as GlobalControlLevel,
      rooms: {
        E29N55: colony.room,
        E29N56: makeTargetRoom('E29N56', 'controller-e29n56' as Id<StructureController>),
        E29N58: makeTargetRoom('E29N58', 'controller-e29n58' as Id<StructureController>)
      }
    };
    setSafeHomeThreat('E29N55', gameTime);

    expect(refreshAutonomousExpansionPipeline(colony, report, gameTime)).toEqual({
      status: 'skipped',
      colony: 'E29N55',
      reason: 'unmetPreconditions',
      reasonDetail: 'activeClaimTarget'
    });
    expect(Memory.territory?.targets).toEqual([recoveryTarget]);
    expect(Memory.territory?.intents).toEqual([recoveryIntent]);
    expect(Memory.territory?.expansionPipelines?.E29N55).toBeUndefined();
  });

  it('reports active post-claim bootstrap blockers separately from generic unmet preconditions', () => {
    const colony = makeColony({ storageEnergy: 2_000 });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W3N1: makePostClaimBootstrap('W1N1', 'W3N1', 'detected')
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 52,
      gcl: { level: 5 } as GlobalControlLevel,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>),
        W3N1: makeTargetRoom('W3N1', 'controller3' as Id<StructureController>, { my: true })
      },
      spawns: {},
      creeps: {}
    };
    setSafeHomeThreat('W1N1', 52);

    expect(refreshAutonomousExpansionPipeline(colony, report, 52)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions',
      reasonDetail: 'activePostClaimBootstrap'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toBeUndefined();
  });

  it('replaces refreshed territory targets instead of inheriting stale fields', () => {
    const colony = makeColony({ storageEnergy: 2_000 });
    const report = makeReport([
      makeCandidate({ roomName: 'W2N1', controllerId: 'controller2' as Id<StructureController> })
    ]);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'reserve',
            enabled: false,
            createdBy: 'expansionPlanner',
            postClaimBootstrapReserveEnergy: 999
          }
        ]
      }
    };
    setSafeHomeThreat('W1N1', 60);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 60,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>)
      }
    };

    expect(refreshAutonomousExpansionPipeline(colony, report, 60)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller2'
      }
    ]);
  });

  it('aborts active pipeline stages and flags the room for re-evaluation when hostiles appear', () => {
    const colony = makeColony({ storageEnergy: 2_000 });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        expansionPipelines: {
          W1N1: {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            status: 'active',
            stage: 'reserving',
            score: 900,
            threshold: 700,
            startedAt: 30,
            updatedAt: 30,
            controllerId: 'controller2' as Id<StructureController>
          }
        },
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'reserve',
            createdBy: 'nextExpansionScoring',
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 31,
      rooms: {
        W1N1: colony.room,
        W2N1: makeTargetRoom('W2N1', 'controller2' as Id<StructureController>, { hostileCreepCount: 1 })
      }
    };
    setSafeHomeThreat('W1N1', 31);

    expect(refreshAutonomousExpansionPipeline(colony, makeReport([]), 31)).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      reason: 'unavailable'
    });
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'aborted',
      abortReason: 'targetHostile',
      abortedAt: 31
    });
    expect(Memory.territory?.expansionReevaluations?.['W1N1>W2N1']).toEqual({
      colony: 'W1N1',
      roomName: 'W2N1',
      reason: 'targetHostile',
      updatedAt: 31,
      score: 900
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
  });
});

function makeReport(candidates: ExpansionCandidateScore[]): ExpansionCandidateReport {
  return {
    candidates,
    next: candidates[0] ?? null
  };
}

function makeCandidate({
  roomName,
  score = 900,
  evidenceStatus = 'sufficient',
  visible = true,
  controllerId = `${roomName}-controller` as Id<StructureController>
}: {
  roomName: string;
  score?: number;
  evidenceStatus?: ExpansionCandidateScore['evidenceStatus'];
  visible?: boolean;
  controllerId?: Id<StructureController> | null;
}): ExpansionCandidateScore {
  return {
    roomName,
    score,
    synergyScore: 0,
    evidenceStatus,
    visible,
    rationale: [],
    preconditions: [],
    risks: [],
    adjacentToOwnedRoom: true,
    sourceCount: 2,
    ...(controllerId ? { controllerId } : {})
  };
}

function makeColony({
  roomName = 'W1N1',
  storageEnergy = 0,
  rcl = 6,
  ticksToDowngrade = 10_000,
  energyAvailable = 1_300,
  energyCapacityAvailable = 1_300
}: {
  roomName?: string;
  storageEnergy?: number;
  rcl?: number;
  ticksToDowngrade?: number;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): ColonySnapshot {
  const room = {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    storage: makeStorage(storageEnergy),
    controller: {
      id: 'controller1' as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: rcl,
      ticksToDowngrade
    } as StructureController,
    memory: {},
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources(roomName, 2) : []))
  } as unknown as Room & { memory: RoomMemory };

  return {
    room,
    spawns: [],
    energyAvailable,
    energyCapacityAvailable,
    memory: room.memory
  };
}

function makeTargetRoom(
  roomName: string,
  controllerId: Id<StructureController>,
  {
    hostileCreepCount = 0,
    sourceCount = 2,
    my = false,
    ownerUsername
  }: {
    hostileCreepCount?: number;
    sourceCount?: number;
    my?: boolean;
    ownerUsername?: string;
  } = {}
): Room {
  const sources = makeSources(roomName, sourceCount);
  const hostiles = Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `hostile-${index}` }));
  const owner = ownerUsername ?? (my ? 'me' : undefined);
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my,
      pos: makePosition(25, 25, roomName),
      ...(owner ? { owner: { username: owner } } : {})
    } as StructureController,
    find: jest.fn((findType: number) => {
      if (findType === FIND_SOURCES) {
        return sources;
      }
      if (findType === FIND_HOSTILE_CREEPS) {
        return hostiles;
      }

      return [];
    })
  } as unknown as Room;
}

function makePostClaimBootstrap(
  colony: string,
  roomName: string,
  status: TerritoryPostClaimBootstrapStatus | 'completed'
): TerritoryPostClaimBootstrapMemory {
  return {
    colony,
    roomName,
    status,
    claimedAt: 1_200_000,
    updatedAt: 1_200_000,
    workerTarget: 2
  } as TerritoryPostClaimBootstrapMemory;
}

function makeStorage(energy: number): StructureStorage {
  return {
    store: {
      getUsedCapacity: jest.fn(() => energy)
    }
  } as unknown as StructureStorage;
}

function makeSources(roomName: string, count: number): Source[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `${roomName}-source${index}` as Id<Source>,
    pos: makePosition(10 + index, 10, roomName)
  })) as Source[];
}

function makePosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function setSafeHomeThreat(roomName: string, updatedAt: number): void {
  const memory = (globalThis as unknown as { Memory: Partial<Memory> }).Memory;
  memory.defense = {
    ...(memory.defense ?? {}),
    colonyThreats: {
      updatedAt,
      rooms: {
        ...(memory.defense?.colonyThreats?.rooms ?? {}),
        [roomName]: {
          roomName,
          level: 'none',
          updatedAt,
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          damagedCriticalStructureCount: 0
        }
      }
    }
  };
}
