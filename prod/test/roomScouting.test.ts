import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  collectVisibleRoomScoutingSnapshot,
  refreshConfiguredExpansionRoomScouting,
  getNearbyRoomScoutingTargets,
  refreshNearbyRoomScouting,
  refreshAdjacentRoomScouting
} from '../src/territory/roomScouting';
import {
  enableRuntimeCurrentRoomScoutTargets,
  installE17S60ExpansionScoutTarget
} from './helpers/runtimeRoomConfig';

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

  it('discovers rooms within two exits and preserves distance metadata for scout requests', () => {
    const colony = makeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 220,
      rooms: {
        W1N1: colony.room
      },
      map: {
        describeExits: jest.fn((roomName: string) => {
          switch (roomName) {
            case 'W1N1':
              return { '1': 'W1N2', '3': 'W2N1' };
            case 'W1N2':
              return { '1': 'W1N3', '3': 'W2N2', '5': 'W1N1' };
            case 'W2N1':
              return { '1': 'W2N2', '3': 'W3N1', '7': 'W1N1' };
            default:
              return {};
          }
        })
      } as unknown as GameMap
    };

    expect(getNearbyRoomScoutingTargets('W1N1')).toEqual([
      { roomName: 'W1N2', distance: 1 },
      { roomName: 'W2N1', distance: 1 },
      { roomName: 'W1N3', distance: 2 },
      { roomName: 'W2N2', distance: 2 },
      { roomName: 'W3N1', distance: 2 }
    ]);

    const result = refreshNearbyRoomScouting(colony, 220);

    expect(result.records).toEqual([
      { colony: 'W1N1', roomName: 'W1N2', status: 'requested', updatedAt: 220, distance: 1 },
      { colony: 'W1N1', roomName: 'W2N1', status: 'requested', updatedAt: 220, distance: 1 },
      { colony: 'W1N1', roomName: 'W1N3', status: 'requested', updatedAt: 220, distance: 2 },
      { colony: 'W1N1', roomName: 'W2N2', status: 'requested', updatedAt: 220, distance: 2 },
      { colony: 'W1N1', roomName: 'W3N1', status: 'requested', updatedAt: 220, distance: 2 }
    ]);
    expect(Memory.territory?.intents?.map((intent) => intent.targetRoom)).toEqual([
      'W1N2',
      'W2N1',
      'W1N3',
      'W2N2',
      'W3N1'
    ]);
  });

  it('requests configured E17S60 expansion scouting when its intel is missing', () => {
    const colony = makeColony('E17S59');
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'E17S59>E18S59': {
            colony: 'E17S59',
            roomName: 'E18S59',
            updatedAt: 300,
            sourceIds: [],
            sourceCount: 0,
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };
    installE17S60ExpansionScoutTarget();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 300,
      rooms: {
        E17S59: colony.room
      }
    };

    const result = refreshConfiguredExpansionRoomScouting(colony, 300);

    expect(result.records).toEqual([
      {
        colony: 'E17S59',
        roomName: 'E17S60',
        status: 'requested',
        updatedAt: 300,
        distance: 2
      }
    ]);
    expect(Memory.territory?.scoutAttempts?.['E17S59>E17S60']).toMatchObject({
      colony: 'E17S59',
      roomName: 'E17S60',
      status: 'requested',
      requestedAt: 300,
      updatedAt: 300,
      attemptCount: 1
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'E17S59',
        targetRoom: 'E17S60',
        action: 'scout',
        status: 'planned',
        updatedAt: 300
      }
    ]);
  });

  it('requests only scout intents for W3N9 adjacent expansion intel refresh targets', () => {
    const colony = makeColony('W3N9');
    enableRuntimeCurrentRoomScoutTargets('W3N9');
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 968_800,
      rooms: {
        W3N9: colony.room
      }
    };

    const result = refreshConfiguredExpansionRoomScouting(colony, 968_800);

    expect(result.records).toEqual([
      {
        colony: 'W3N9',
        roomName: 'W3N8',
        status: 'requested',
        updatedAt: 968_800,
        distance: 1
      },
      {
        colony: 'W3N9',
        roomName: 'W2N9',
        status: 'requested',
        updatedAt: 968_800,
        distance: 1
      }
    ]);
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W3N9',
        targetRoom: 'W3N8',
        action: 'scout',
        status: 'planned',
        updatedAt: 968_800
      },
      {
        colony: 'W3N9',
        targetRoom: 'W2N9',
        action: 'scout',
        status: 'planned',
        updatedAt: 968_800
      }
    ]);
  });
});

function makeColony(roomName = 'W1N1'): ColonySnapshot {
  const room = {
    name: roomName,
    energyAvailable: 650,
    energyCapacityAvailable: 650,
    controller: {
      id: `controller-${roomName}`,
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
