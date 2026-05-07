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

  it('persists the highest-scored scouted expansion as a claim target and reuses the cache', () => {
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
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(colony.room.memory.cachedExpansionSelection).toMatchObject({
      status: 'planned',
      targetRoom: 'W3N1'
    });

    getRoomTerrain.mockImplementation(() => {
      throw new Error('cached expansion executor selection should avoid rescoring');
    });

    expect(refreshExpansionExecutorIntent(colony, 101)).toMatchObject({
      status: 'planned',
      targetRoom: 'W3N1'
    });
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
});

function makeColony(): ColonySnapshot {
  const room = {
    name: 'W1N1',
    energyAvailable: 650,
    energyCapacityAvailable: 650,
    controller: {
      id: 'controller1' as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    memory: {},
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources('W1N1', 2) : []))
  } as unknown as Room & { memory: RoomMemory };

  return {
    room,
    spawns: [],
    energyAvailable: 650,
    energyCapacityAvailable: 650,
    memory: room.memory
  };
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
