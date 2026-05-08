import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
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
  storageEnergy = 0,
  rcl = 3
}: {
  storageEnergy?: number;
  rcl?: number;
} = {}): ColonySnapshot {
  const room = {
    name: 'W1N1',
    energyAvailable: 1_300,
    energyCapacityAvailable: 1_300,
    storage: makeStorage(storageEnergy),
    controller: {
      id: 'controller1' as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: rcl,
      ticksToDowngrade: 10_000
    } as StructureController,
    memory: {},
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources('W1N1', 2) : []))
  } as unknown as Room & { memory: RoomMemory };

  return {
    room,
    spawns: [],
    energyAvailable: 1_300,
    energyCapacityAvailable: 1_300,
    memory: room.memory
  };
}

function makeTargetRoom(
  roomName: string,
  controllerId: Id<StructureController>,
  {
    hostileCreepCount = 0,
    sourceCount = 2
  }: {
    hostileCreepCount?: number;
    sourceCount?: number;
  } = {}
): Room {
  const sources = makeSources(roomName, sourceCount);
  const hostiles = Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `hostile-${index}` }));
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my: false,
      pos: makePosition(25, 25, roomName)
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
