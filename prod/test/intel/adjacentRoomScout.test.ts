import {
  getFreshRoomScoutReport,
  rankAdjacentRoomScoutReports,
  refreshAdjacentRoomScoutReports,
  scoreRoomScoutReport
} from '../../src/intel/adjacentRoomScout';

describe('adjacent room scout reports', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { STRUCTURE_OBSERVER: string }).STRUCTURE_OBSERVER = 'observer';
    (globalThis as unknown as { OK: ScreepsReturnCode }).OK = 0 as ScreepsReturnCode;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { FIND_MINERALS?: number }).FIND_MINERALS;
    delete (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
    delete (globalThis as { STRUCTURE_OBSERVER?: string }).STRUCTURE_OBSERVER;
    delete (globalThis as { OK?: ScreepsReturnCode }).OK;
  });

  it('records terrain-only reports for all E17S59 adjacent rooms and visible details when available', () => {
    const terrain = makeTerrain();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1234,
      rooms: {
        E17S60: makeVisibleRoom('E17S60', { sourceCount: 2, mineralType: 'O' })
      },
      map: {
        describeExits: jest.fn((roomName: string) =>
          roomName === 'E17S59'
            ? { '1': 'E17S58', '3': 'E18S59', '5': 'E17S60', '7': 'E16S59' }
            : {}
        ),
        getRoomTerrain: jest.fn(() => terrain)
      } as unknown as GameMap
    };

    const reports = refreshAdjacentRoomScoutReports('E17S59', 1234);

    expect(reports.map((report) => report.roomName)).toEqual(['E17S58', 'E18S59', 'E17S60', 'E16S59']);
    expect(Memory.intel?.scoutReports?.E17S58).toMatchObject({
      roomName: 'E17S58',
      terrain: { plains: 2114, swamp: 1, wall: 1 },
      timestamp: 1234,
      visible: false
    });
    expect(Memory.intel?.scoutReports?.E17S60).toMatchObject({
      roomName: 'E17S60',
      terrain: { plains: 2114, swamp: 1, wall: 1 },
      timestamp: 1234,
      visible: true,
      owner: null,
      controller: {
        present: true,
        state: 'unreserved',
        id: 'controller-E17S60'
      },
      sourceCount: 2,
      mineralType: 'O'
    });
  });

  it('requests one observer scan when terrain-only adjacent reports need visibility', () => {
    const observeRoom = jest.fn(() => 0 as ScreepsReturnCode);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 300,
      rooms: {
        E17S59: {
          name: 'E17S59',
          find: jest.fn((findType: number) =>
            findType === FIND_MY_STRUCTURES
              ? [{ structureType: STRUCTURE_OBSERVER, observeRoom }]
              : []
          )
        } as unknown as Room
      },
      map: {
        describeExits: jest.fn((roomName: string) =>
          roomName === 'E17S59' ? { '1': 'E17S58', '3': 'E18S59' } : {}
        ),
        getRoomTerrain: jest.fn(() => makeTerrain())
      } as unknown as GameMap
    };

    refreshAdjacentRoomScoutReports('E17S59', 300);

    expect(observeRoom).toHaveBeenCalledTimes(1);
    expect(observeRoom).toHaveBeenCalledWith('E17S58');
    expect(Memory.intel?.scoutReports?.E17S58?.observerRequested).toBe(true);
    expect(Memory.intel?.scoutReports?.E18S59?.observerRequested).toBeUndefined();
  });

  it('ranks adjacent reports by plains, sources, unowned controller presence, and ownership risk', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 500,
      rooms: {
        E17S60: makeVisibleRoom('E17S60', { sourceCount: 2 }),
        E18S59: makeVisibleRoom('E18S59', { ownerUsername: 'enemy', sourceCount: 2 })
      },
      map: {
        describeExits: jest.fn((roomName: string) =>
          roomName === 'E17S59' ? { '3': 'E18S59', '5': 'E17S60' } : {}
        ),
        getRoomTerrain: jest.fn((roomName: string) => makeTerrain(roomName === 'E17S60' ? 0 : 400))
      } as unknown as GameMap
    };

    const ranking = rankAdjacentRoomScoutReports('E17S59', 500);

    expect(ranking.map((score) => score.roomName)).toEqual(['E17S60', 'E18S59']);
    expect(ranking[0].score).toBeGreaterThan(ranking[1].score);
    expect(scoreRoomScoutReport(ranking[0].report).rationale).toEqual(
      expect.arrayContaining(['2 sources', 'controller present', 'owner absent'])
    );
  });

  it('drops stale scout reports after the 10k tick TTL', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      intel: {
        scoutReports: {
          E17S58: {
            roomName: 'E17S58',
            terrain: { plains: 2000, swamp: 50, wall: 66 },
            timestamp: 10
          }
        }
      }
    };

    expect(getFreshRoomScoutReport('E17S58', 10_010)).not.toBeNull();
    expect(getFreshRoomScoutReport('E17S58', 10_011)).toBeNull();
  });
});

function makeVisibleRoom(
  roomName: string,
  {
    sourceCount = 1,
    mineralType,
    ownerUsername
  }: {
    sourceCount?: number;
    mineralType?: string;
    ownerUsername?: string;
  } = {}
): Room {
  return {
    name: roomName,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false,
      ...(ownerUsername ? { owner: { username: ownerUsername } } : {})
    } as StructureController,
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case FIND_SOURCES:
          return Array.from({ length: sourceCount }, (_value, index) => ({
            id: `${roomName}-source-${index}`
          }));
        case FIND_MINERALS:
          return mineralType ? [{ id: `${roomName}-mineral`, mineralType }] : [];
        default:
          return [];
      }
    })
  } as unknown as Room;
}

function makeTerrain(wallBefore = 1): RoomTerrain {
  return {
    get: jest.fn((x: number, y: number) => {
      const index = (x - 2) * 46 + (y - 2);
      if (index < wallBefore) {
        return TERRAIN_MASK_WALL;
      }

      return index === wallBefore ? TERRAIN_MASK_SWAMP : 0;
    })
  } as unknown as RoomTerrain;
}
