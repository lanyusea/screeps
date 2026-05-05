import {
  scoreClaimTarget,
  selectBestClaimTarget
} from '../src/territory/claimScoring';

describe('claim scoring', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
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
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
  });

  it('scores a two-source room higher than a one-source room', () => {
    const homeRoom = makeHomeRoom();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: homeRoom,
        W2N1: makeClaimRoom('W2N1', { sourceCount: 1 }),
        W1N2: makeClaimRoom('W1N2', { sourceCount: 2 })
      },
      map: makeMap({
        exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
      })
    };

    const singleSource = scoreClaimTarget('W2N1', homeRoom);
    const dualSource = scoreClaimTarget('W1N2', homeRoom);

    expect(dualSource.sources).toBe(2);
    expect(singleSource.sources).toBe(1);
    expect(dualSource.score).toBeGreaterThan(singleSource.score);
    expect(selectBestClaimTarget(homeRoom)).toBe('W1N2');
  });

  it('scores a hostile room at zero or below', () => {
    const homeRoom = makeHomeRoom();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: homeRoom,
        W2N1: makeClaimRoom('W2N1', { sourceCount: 2, hostileCreepCount: 1 })
      },
      map: makeMap({
        exits: { W1N1: { '3': 'W2N1' } }
      })
    };

    const score = scoreClaimTarget('W2N1', homeRoom);

    expect(score.score).toBeLessThanOrEqual(0);
    expect(score.details).toContain('hostile presence 1');
    expect(selectBestClaimTarget(homeRoom)).toBeNull();
  });

  it('excludes already claimed and reserved adjacent rooms', () => {
    const homeRoom = makeHomeRoom();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: homeRoom,
        W1N2: makeClaimRoom('W1N2', { sourceCount: 2, controller: { my: true } }),
        W2N1: makeClaimRoom('W2N1', {
          sourceCount: 2,
          controller: { reservation: { username: 'me', ticksToEnd: 4_000 } }
        }),
        W1N0: makeClaimRoom('W1N0', { sourceCount: 1 })
      },
      map: makeMap({
        exits: { W1N1: { '1': 'W1N2', '3': 'W2N1', '5': 'W1N0' } }
      })
    };

    expect(scoreClaimTarget('W1N2', homeRoom).details).toContain('controller already claimed');
    expect(scoreClaimTarget('W2N1', homeRoom).details).toContain('controller already reserved');
    expect(selectBestClaimTarget(homeRoom)).toBe('W1N0');
  });

  it('penalizes farther rooms by route distance', () => {
    const homeRoom = makeHomeRoom();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: homeRoom,
        W2N1: makeClaimRoom('W2N1', { sourceCount: 1 }),
        W5N1: makeClaimRoom('W5N1', { sourceCount: 1 })
      },
      map: makeMap({
        routeDistances: {
          'W1N1>W2N1': 1,
          'W1N1>W5N1': 4
        }
      })
    };

    const near = scoreClaimTarget('W2N1', homeRoom);
    const far = scoreClaimTarget('W5N1', homeRoom);

    expect(near.distance).toBe(1);
    expect(far.distance).toBe(4);
    expect(near.score).toBeGreaterThan(far.score);
  });
});

function makeHomeRoom(): Room {
  return makeClaimRoom('W1N1', { sourceCount: 2, controller: { my: true, owner: { username: 'me' } } });
}

function makeClaimRoom(
  roomName: string,
  options: {
    sourceCount: number;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
    controller?: Partial<StructureController>;
  }
): Room {
  const sources = Array.from({ length: options.sourceCount }, (_value, index) =>
    makeSource(`source-${roomName}-${index}`, 10 + index * 10, 10 + index * 10, roomName)
  );
  const hostileCreeps = Array.from({ length: options.hostileCreepCount ?? 0 }, (_value, index) => ({
    id: `hostile-creep-${index}`
  })) as Creep[];
  const hostileStructures = Array.from({ length: options.hostileStructureCount ?? 0 }, (_value, index) => ({
    id: `hostile-structure-${index}`
  })) as Structure[];

  return {
    name: roomName,
    controller: makeController(roomName, options.controller),
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

function makeMap({
  exits = {},
  routeDistances = {}
}: {
  exits?: Record<string, Partial<Record<'1' | '3' | '5' | '7', string>>>;
  routeDistances?: Record<string, number>;
}): GameMap {
  return {
    describeExits: jest.fn((roomName: string) => exits[roomName] ?? {}),
    findRoute: jest.fn((fromRoom: string, toRoom: string) =>
      Array.from({ length: routeDistances[`${fromRoom}>${toRoom}`] ?? 1 }, (_value, index) => ({
        exit: 3,
        room: `${toRoom}-${index}`
      }))
    ),
    getRoomLinearDistance: jest.fn((_fromRoom: string, _toRoom: string) => 1),
    getRoomTerrain: jest.fn(() => makeTerrain())
  } as unknown as GameMap;
}

function makeTerrain(): RoomTerrain {
  return {
    get: jest.fn((x: number) => (x <= 3 ? TERRAIN_MASK_WALL : 0))
  } as unknown as RoomTerrain;
}
