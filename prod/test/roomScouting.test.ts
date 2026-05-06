import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  collectVisibleRoomScoutingSnapshot,
  refreshAdjacentRoomScouting
} from '../src/territory/roomScouting';

describe('room scouting', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
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
    delete (globalThis as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN;
  });

  it('collects source count, controller presence, and terrain type from a visible room', () => {
    const room = makeRoom('W1N2', {
      sourceCount: 2,
      terrain: makeTerrain((x) => (x < 25 ? TERRAIN_MASK_SWAMP : 0))
    });

    const snapshot = collectVisibleRoomScoutingSnapshot(room);

    expect(snapshot).toMatchObject({
      roomName: 'W1N2',
      controllerPresent: true,
      controllerId: 'controller-W1N2',
      sourceCount: 2,
      terrainType: 'swamp',
      terrainQuality: {
        walkableRatio: 1,
        swampRatio: 0.5,
        wallRatio: 0
      }
    });
    expect(snapshot.sources).toHaveLength(2);
  });

  it('records visible adjacent room intel and requests scouts for unseen adjacent rooms', () => {
    const colony = makeColony();
    const visibleAdjacent = makeRoom('W1N2', { sourceCount: 1 });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100,
      rooms: {
        W1N1: colony.room,
        W1N2: visibleAdjacent
      },
      map: {
        describeExits: jest.fn((roomName: string) =>
          roomName === 'W1N1' ? { '1': 'W1N2', '3': 'W2N1' } : {}
        )
      } as unknown as GameMap
    };

    const result = refreshAdjacentRoomScouting(colony, 100);

    expect(result).toEqual({
      colony: 'W1N1',
      records: [
        {
          colony: 'W1N1',
          roomName: 'W1N2',
          status: 'observed',
          updatedAt: 100,
          sourceCount: 1,
          controllerPresent: true,
          controllerId: 'controller-W1N2',
          terrainType: 'plain'
        },
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          status: 'requested',
          updatedAt: 100
        }
      ]
    });
    expect(Memory.territory?.scoutIntel?.['W1N1>W1N2']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W1N2',
      updatedAt: 100,
      controller: { id: 'controller-W1N2', my: false },
      sourceCount: 1,
      terrain: {
        walkableRatio: 1,
        swampRatio: 0,
        wallRatio: 0
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 100
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
      id: 'controller-W1N1',
      my: true,
      level: 3,
      owner: { username: 'me' }
    } as StructureController,
    find: jest.fn(() => [])
  } as unknown as Room;
  return { room, spawns: [], energyAvailable: 650, energyCapacityAvailable: 650 };
}

function makeRoom(
  roomName: string,
  {
    sourceCount,
    terrain = makeTerrain()
  }: {
    sourceCount: number;
    terrain?: RoomTerrain;
  }
): Room {
  const sources = Array.from({ length: sourceCount }, (_value, index) => ({
    id: `source-${roomName}-${index}` as Id<Source>,
    pos: { x: 10 + index, y: 20 + index, roomName } as RoomPosition
  })) as Source[];

  return {
    name: roomName,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false,
      pos: { x: 25, y: 25, roomName } as RoomPosition
    } as StructureController,
    getTerrain: jest.fn(() => terrain),
    find: jest.fn((findType: number) => {
      if (findType === FIND_SOURCES) {
        return sources;
      }

      return [];
    })
  } as unknown as Room;
}

function makeTerrain(get: (x: number, y: number) => number = () => 0): RoomTerrain {
  return { get: jest.fn(get) } as unknown as RoomTerrain;
}
