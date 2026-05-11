import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { refreshExpansionExecutorIntent } from '../src/territory/expansionExecutor';

describe('expansion executor', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
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
  });

  it('persists the highest-scored scouted expansion as a reserve target and reuses the active pipeline', () => {
    const colony = makeColony();
    const getRoomTerrain = jest.fn(() => makeTerrain(0));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 1),
        W3N1: makeExpansionRoom('W3N1', 'controller3' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '1': 'W2N1', '3': 'W3N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'next' }]),
        getRoomTerrain
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 100);

    expect(refreshExpansionExecutorIntent(colony, 100)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      controllerId: 'controller3'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'reserve',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      status: 'active',
      stage: 'reserving',
      score: expect.any(Number),
      threshold: expect.any(Number)
    });
    expect(colony.room.memory.cachedExpansionSelection).toMatchObject({
      status: 'planned',
      targetRoom: 'W3N1'
    });

    getRoomTerrain.mockImplementation(() => {
      throw new Error('active expansion pipeline should avoid rescoring');
    });
    colony.energyAvailable = 1_299;
    (colony.room as Room & { energyAvailable: number }).energyAvailable = 1_299;
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { time: number }).time = 101;

    expect(refreshExpansionExecutorIntent(colony, 101)).toMatchObject({
      status: 'planned',
      targetRoom: 'W3N1'
    });
  });

  it('revalidates claim readiness before reusing a cached planned selection', () => {
    const colony = makeColony();
    const homeSources = makeSources('W1N1', 2);
    let hostileCreepCount = 0;
    (colony.room.find as jest.Mock).mockImplementation((findType: number) => {
      if (findType === FIND_SOURCES) {
        return homeSources;
      }
      if (findType === FIND_HOSTILE_CREEPS) {
        return Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `hostile-${index}` }));
      }

      return [];
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 150,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 150);

    expect(refreshExpansionExecutorIntent(colony, 150)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });

    hostileCreepCount = 1;
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { time: number }).time = 151;

    expect(refreshExpansionExecutorIntent(colony, 151)).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'aborted',
      abortReason: 'homeUnstable'
    });

    hostileCreepCount = 0;
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { time: number }).time = 152;

    expect(refreshExpansionExecutorIntent(colony, 152)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });
  });

  it('blocks claiming when recent threat memory was not refreshed on the current tick', () => {
    const colony = makeColony();
    Memory.defense = {
      colonyThreats: {
        updatedAt: 199,
        rooms: {
          W1N1: {
            roomName: 'W1N1',
            level: 'hostile_present',
            updatedAt: 199,
            hostileCreepCount: 1,
            hostileStructureCount: 0,
            damagedCriticalStructureCount: 0
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    expect(refreshExpansionExecutorIntent(colony, 200)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
  });

  it('blocks claiming when recent threat memory omits the colony room', () => {
    const colony = makeColony();
    Memory.defense = {
      colonyThreats: {
        updatedAt: 200,
        rooms: {
          W9N9: {
            roomName: 'W9N9',
            level: 'hostile_present',
            updatedAt: 200,
            hostileCreepCount: 1,
            hostileStructureCount: 0,
            damagedCriticalStructureCount: 0
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    expect(refreshExpansionExecutorIntent(colony, 200)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
  });

  it('requests scouting for the highest-ranked unseen expansion candidate', () => {
    const colony = makeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: {
        W1N1: colony.room
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 200);

    expect(refreshExpansionExecutorIntent(colony, 200)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'insufficientEvidence'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutAttempts?.['W1N1>W2N1']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      status: 'requested',
      requestedAt: 200,
      updatedAt: 200,
      attemptCount: 1
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 200
      }
    ]);
  });

  it('requests configured E24S49 expansion scout targets', () => {
    const colony = makeColony({ roomName: 'E24S49' });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 821,
      rooms: {
        E24S49: colony.room
      },
      map: {
        describeExits: jest.fn(() => ({})),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('E24S49', 821);

    expect(refreshExpansionExecutorIntent(colony, 821)).toEqual({
      status: 'skipped',
      colony: 'E24S49',
      reason: 'insufficientEvidence'
    });
    expect(Memory.territory?.expansionCandidates?.[0]).toMatchObject({
      colony: 'E24S49',
      roomName: 'E26S50',
      evidenceStatus: 'insufficient-evidence',
      recommendedAction: 'scout',
      visible: false,
      adjacentToOwnedRoom: true,
      nearestOwnedRoom: 'E24S49',
      nearestOwnedRoomDistance: 1,
      routeDistance: 1
    });
    expect(Memory.territory?.scoutAttempts?.['E24S49>E26S50']).toMatchObject({
      colony: 'E24S49',
      roomName: 'E26S50',
      status: 'requested',
      requestedAt: 821,
      updatedAt: 821,
      attemptCount: 1
    });
    expect(Memory.territory?.scoutAttempts?.['E24S49>E26S47']).toMatchObject({
      colony: 'E24S49',
      roomName: 'E26S47',
      status: 'requested',
      requestedAt: 821,
      updatedAt: 821,
      attemptCount: 1
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'E24S49',
        targetRoom: 'E26S50',
        action: 'scout',
        status: 'planned',
        updatedAt: 821
      },
      {
        colony: 'E24S49',
        targetRoom: 'E26S47',
        action: 'scout',
        status: 'planned',
        updatedAt: 821
      }
    ]);
  });

  it('skips and clears claim targets when the colony is not ready to bootstrap an expansion', () => {
    const colony = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    Memory.territory = {
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
          updatedAt: 190,
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller2' as Id<StructureController>
        }
      ]
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 300,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    expect(refreshExpansionExecutorIntent(colony, 300)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
    expect(Memory.territory?.intents ?? []).toEqual([]);
  });
});

function makeColony({
  roomName = 'W1N1',
  energyAvailable = 1_300,
  energyCapacityAvailable = 1_300,
  spawns
}: {
  roomName?: string;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  spawns?: StructureSpawn[];
} = {}): ColonySnapshot {
  const colonySpawns = spawns ?? [makeActiveSpawn(`spawn-${roomName}`)];
  const room = {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    memory: {},
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources(roomName, 2) : []))
  } as unknown as Room & { memory: RoomMemory };

  return {
    room,
    spawns: colonySpawns,
    energyAvailable,
    energyCapacityAvailable,
    memory: room.memory
  };
}

function makeActiveSpawn(name: string): StructureSpawn {
  return {
    id: `${name}-id` as Id<StructureSpawn>,
    name,
    spawning: null,
    isActive: jest.fn(() => true)
  } as unknown as StructureSpawn;
}

function makeExpansionRoom(
  roomName: string,
  controllerId: Id<StructureController>,
  sourceCount: number
): Room {
  const sources = makeSources(roomName, sourceCount);
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my: false,
      pos: makePosition(25, 25, roomName)
    } as StructureController,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    find: jest.fn((findType: number) => {
      if (findType === FIND_SOURCES) {
        return sources;
      }

      return [];
    })
  } as unknown as Room;
}

function makeSources(roomName: string, count: number): Source[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${roomName}-source${index}` as Id<Source>,
    pos: makePosition(10 + index, 10, roomName)
  })) as Source[];
}

function makePosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function makeTerrain(mask: number): RoomTerrain {
  return {
    get: jest.fn(() => mask)
  } as unknown as RoomTerrain;
}

function setSafeHomeThreat(roomName: string, updatedAt: number): void {
  Memory.defense = {
    ...(Memory.defense ?? {}),
    colonyThreats: {
      updatedAt,
      rooms: {
        ...(Memory.defense?.colonyThreats?.rooms ?? {}),
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
