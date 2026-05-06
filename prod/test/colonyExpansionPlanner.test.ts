import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { assessColonyStage } from '../src/colony/colonyStage';
import { scoreClaimTarget } from '../src/territory/claimScoring';
import {
  COLONY_EXPANSION_CLAIM_TARGET_CREATOR,
  MIN_COLONY_EXPANSION_CLAIM_SCORE,
  refreshColonyExpansionIntent
} from '../src/territory/colonyExpansionPlanner';
import { planTerritoryIntent } from '../src/territory/territoryPlanner';

describe('colony expansion planner', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 4;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { FIND_MINERALS?: number }).FIND_MINERALS;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
  });

  it('auto-claims the highest claim-scored adjacent room once the colony is stable', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      rooms: {
        W2N1: makeExpansionRoom('W2N1', { sourceCount: 1 }),
        W1N2: makeExpansionRoom('W1N2', { sourceCount: 2 })
      },
      exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
    });
    const stableAssessment = assessColonyStage({
      roomName: 'W1N1',
      totalCreeps: 5,
      workerCapacity: 3,
      workerTarget: 3,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
    });
    const selectedScore = scoreClaimTarget('W1N2', colony.room).score;

    const evaluation = refreshColonyExpansionIntent(colony, stableAssessment, 200);

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W1N2',
      controllerId: 'controller-W1N2',
      score: selectedScore
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'claim',
        createdBy: COLONY_EXPANSION_CLAIM_TARGET_CREATOR,
        controllerId: 'controller-W1N2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'claim',
        status: 'planned',
        updatedAt: 200,
        createdBy: COLONY_EXPANSION_CLAIM_TARGET_CREATOR,
        controllerId: 'controller-W1N2'
      }
    ]);
    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 201)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'claim',
      createdBy: COLONY_EXPANSION_CLAIM_TARGET_CREATOR,
      controllerId: 'controller-W1N2'
    });
  });

  it('reserves high-score adjacent rooms but suppresses auto-claim during bootstrap', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      rooms: {
        W2N1: makeExpansionRoom('W2N1', { sourceCount: 1 }),
        W1N2: makeExpansionRoom('W1N2', { sourceCount: 2 })
      },
      exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
    });
    const bootstrapAssessment = assessColonyStage({
      roomName: 'W1N1',
      totalCreeps: 1,
      workerCapacity: 1,
      workerTarget: 3,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
    });

    const evaluation = refreshColonyExpansionIntent(colony, bootstrapAssessment, 210);

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'colonyUnstable',
      targetRoom: 'W1N2',
      reservation: {
        status: 'planned',
        claimBlocker: 'colonyUnstable',
        targetRoom: 'W1N2'
      }
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'reserve',
        createdBy: 'adjacentRoomReservation',
        controllerId: 'controller-W1N2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 210,
        createdBy: 'adjacentRoomReservation',
        controllerId: 'controller-W1N2'
      }
    ]);
    expect(Memory.territory?.targets?.some((target) => target.action === 'claim')).toBe(false);
  });

  it('uses resource synergy to rank otherwise equal expansion claim candidates', () => {
    const { colony } = makeColony({
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_000,
      sourceCount: 2,
      mineralType: 'H'
    });
    installGame(colony, {
      rooms: {
        W2N1: makeExpansionRoom('W2N1', { sourceCount: 2, mineralType: 'H' }),
        W1N2: makeExpansionRoom('W1N2', { sourceCount: 2, mineralType: 'O' })
      },
      exits: { W1N1: { '1': 'W2N1', '3': 'W1N2' } }
    });
    const stableAssessment = assessColonyStage({
      roomName: 'W1N1',
      totalCreeps: 5,
      workerCapacity: 3,
      workerTarget: 3,
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_000,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
    });
    const duplicateScore = scoreClaimTarget('W2N1', colony.room).score;

    expect(scoreClaimTarget('W1N2', colony.room).score).toBe(duplicateScore);

    const evaluation = refreshColonyExpansionIntent(colony, stableAssessment, 230);

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W1N2',
      controllerId: 'controller-W1N2',
      score: duplicateScore
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'claim',
        createdBy: COLONY_EXPANSION_CLAIM_TARGET_CREATOR,
        controllerId: 'controller-W1N2'
      }
    ]);
  });

  it('ignores sub-threshold rooms when applying synergy to expansion claim ranking', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      sourceCount: 1,
      mineralType: 'H'
    });
    installGame(colony, {
      rooms: {
        W2N1: makeExpansionRoom('W2N1', { sourceCount: 2, mineralType: 'H' }),
        W1N2: makeExpansionRoom('W1N2', { sourceCount: 1, mineralType: 'O' })
      },
      exits: { W1N1: { '1': 'W2N1', '3': 'W1N2' } }
    });
    const stableAssessment = assessColonyStage({
      roomName: 'W1N1',
      totalCreeps: 5,
      workerCapacity: 3,
      workerTarget: 3,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
    });
    const eligibleScore = scoreClaimTarget('W2N1', colony.room).score;
    const subThresholdScore = scoreClaimTarget('W1N2', colony.room).score;

    expect(eligibleScore).toBeGreaterThanOrEqual(MIN_COLONY_EXPANSION_CLAIM_SCORE);
    expect(subThresholdScore).toBeLessThan(MIN_COLONY_EXPANSION_CLAIM_SCORE);

    const evaluation = refreshColonyExpansionIntent(colony, stableAssessment, 240);

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller-W2N1',
      score: eligibleScore
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: COLONY_EXPANSION_CLAIM_TARGET_CREATOR,
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('reserves a low-priority adjacent room when it is below the claim threshold', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      rooms: {
        W2N1: makeExpansionRoom('W2N1', { sourceCount: 1 })
      },
      exits: { W1N1: { '3': 'W2N1' } }
    });
    const stableAssessment = assessColonyStage({
      roomName: 'W1N1',
      totalCreeps: 5,
      workerCapacity: 3,
      workerTarget: 3,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
    });

    const evaluation = refreshColonyExpansionIntent(colony, stableAssessment, 220);

    expect(evaluation).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'scoreBelowThreshold',
      reservation: {
        status: 'planned',
        targetRoom: 'W2N1'
      }
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'adjacentRoomReservation',
        controllerId: 'controller-W2N1'
      }
    ]);
  });
});

function makeColony({
  roomName = 'W1N1',
  energyAvailable,
  energyCapacityAvailable,
  sourceCount = 1,
  mineralType
}: {
  roomName?: string;
  energyAvailable: number;
  energyCapacityAvailable: number;
  sourceCount?: number;
  mineralType?: string;
}): { colony: ColonySnapshot } {
  const room = makeExpansionRoom(roomName, {
    sourceCount,
    mineralType,
    controller: {
      my: true,
      level: 3,
      ticksToDowngrade: 10_000,
      owner: { username: 'me' }
    }
  });
  room.energyAvailable = energyAvailable;
  room.energyCapacityAvailable = energyCapacityAvailable;

  return {
    colony: { room, spawns: [], energyAvailable, energyCapacityAvailable }
  };
}

function installGame(
  colony: ColonySnapshot,
  {
    rooms,
    exits
  }: {
    rooms: Record<string, Room>;
    exits: Record<string, Partial<Record<'1' | '3' | '5' | '7', string>>>;
  }
): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 200,
    gcl: { level: 5, progress: 0, progressTotal: 0 } as GlobalControlLevel,
    rooms: { [colony.room.name]: colony.room, ...rooms },
    spawns: {},
    creeps: {},
    getObjectById: jest.fn().mockReturnValue(null),
    map: makeMap(exits)
  };
}

function makeExpansionRoom(
  roomName: string,
  options: {
    sourceCount: number;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
    mineralType?: string;
    controller?: Partial<StructureController> | null;
  }
): Room {
  const sources = Array.from({ length: options.sourceCount }, (_value, index) =>
    makeSource(`source-${roomName}-${index}`, 20 + index * 10, 20 + index * 10, roomName)
  );
  const hostileCreeps = Array.from({ length: options.hostileCreepCount ?? 0 }, (_value, index) => ({
    id: `hostile-creep-${index}`
  })) as Creep[];
  const hostileStructures = Array.from({ length: options.hostileStructureCount ?? 0 }, (_value, index) => ({
    id: `hostile-structure-${index}`
  })) as Structure[];

  return {
    name: roomName,
    controller: options.controller === null ? undefined : makeController(roomName, options.controller),
    find: jest.fn((findType: number) => {
      if (findType === FIND_SOURCES) {
        return sources;
      }

      if (findType === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
      }

      if (findType === FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      if (findType === FIND_MINERALS) {
        return options.mineralType
          ? [
              {
                id: `mineral-${roomName}`,
                mineralType: options.mineralType,
                density: 1
              }
            ]
          : [];
      }

      return [];
    })
  } as unknown as Room;
}

function makeController(
  roomName: string,
  overrides: Partial<StructureController> = {}
): StructureController {
  return {
    id: `controller-${roomName}` as Id<StructureController>,
    my: false,
    pos: makeRoomPosition(25, 25, roomName),
    ...overrides
  } as StructureController;
}

function makeSource(id: string, x: number, y: number, roomName: string): Source {
  return {
    id: id as Id<Source>,
    pos: makeRoomPosition(x, y, roomName)
  } as Source;
}

function makeRoomPosition(x: number, y: number, roomName: string): RoomPosition {
  return {
    x,
    y,
    roomName,
    getRangeTo: (target: RoomPosition) => Math.max(Math.abs(x - target.x), Math.abs(y - target.y))
  } as RoomPosition;
}

function makeMap(exits: Record<string, Partial<Record<'1' | '3' | '5' | '7', string>>>): GameMap {
  return {
    describeExits: jest.fn((roomName: string) => exits[roomName] ?? {}),
    findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 3, room: toRoom }]),
    getRoomLinearDistance: jest.fn((_fromRoom: string, _toRoom: string) => 1),
    getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) } as unknown as RoomTerrain))
  } as unknown as GameMap;
}
