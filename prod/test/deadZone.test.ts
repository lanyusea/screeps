import {
  DEAD_ZONE_MEMORY_TTL,
  getKnownDeadZoneRoom,
  hasSafeRouteAvoidingDeadZones,
  isKnownDeadZoneRoom,
  refreshVisibleDeadZoneMemory
} from '../src/defense/deadZone';

const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
type TestFindRouteOptions = { routeCallback?: (roomName: string, fromRoomName: string) => number };

const TEST_GLOBALS = {
  FIND_HOSTILE_CREEPS: 101,
  FIND_HOSTILE_STRUCTURES: 102,
  STRUCTURE_TOWER: 'tower'
} as const;

describe('dead-zone memory', () => {
  beforeEach(() => {
    Object.assign(globalThis, TEST_GLOBALS);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('expires stale unseen unsafe room memory before returning it', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      defense: {
        unsafeRooms: {
          W2N1: makeUnsafeRoomMemory('W2N1', 100)
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100 + DEAD_ZONE_MEMORY_TTL + 1,
      rooms: {}
    };

    expect(getKnownDeadZoneRoom('W2N1')).toBeNull();
    expect(Memory.defense?.unsafeRooms).toBeUndefined();
  });

  it('keeps fresh unsafe room memory through the TTL boundary', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      defense: {
        unsafeRooms: {
          W2N1: makeUnsafeRoomMemory('W2N1', 100)
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100 + DEAD_ZONE_MEMORY_TTL,
      rooms: {}
    };

    expect(getKnownDeadZoneRoom('W2N1')).toMatchObject({
      roomName: 'W2N1',
      updatedAt: 100
    });
  });

  it('clears stale unsafe room memory during the once-per-tick visible refresh', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      defense: {
        unsafeRooms: {
          W2N1: makeUnsafeRoomMemory('W2N1', 100)
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100 + DEAD_ZONE_MEMORY_TTL + 1,
      rooms: {}
    };

    refreshVisibleDeadZoneMemory();

    expect(Memory.defense?.unsafeRooms).toBeUndefined();
  });

  it('checks visible rooms without writing defense memory', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: { W2N1: makeRoom('W2N1', [makeHostileTower('tower1', 'W2N1')]) }
    };

    expect(isKnownDeadZoneRoom('W2N1')).toBe(true);
    expect(Memory.defense).toBeUndefined();
  });

  it('keeps route callbacks read-only for visible unsafe rooms', () => {
    const findRoute = jest.fn((_fromRoom: string, _toRoom: string, options?: TestFindRouteOptions) =>
      options?.routeCallback?.('W2N1', 'W1N1') === Infinity
        ? ERR_NO_PATH_CODE
        : [{ exit: 3, room: 'W2N1' }]
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 201,
      map: { findRoute } as unknown as GameMap,
      rooms: { W2N1: makeRoom('W2N1', [makeHostileTower('tower1', 'W2N1')]) }
    };

    expect(hasSafeRouteAvoidingDeadZones('W1N1', 'W3N1')).toBe(false);
    expect(Memory.defense).toBeUndefined();
  });

  it('expires stale unseen memory used by route callbacks', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      defense: {
        unsafeRooms: {
          W2N1: makeUnsafeRoomMemory('W2N1', 100)
        }
      }
    };
    const findRoute = jest.fn((_fromRoom: string, _toRoom: string, options?: TestFindRouteOptions) =>
      options?.routeCallback?.('W2N1', 'W1N1') === Infinity
        ? ERR_NO_PATH_CODE
        : [{ exit: 3, room: 'W2N1' }]
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100 + DEAD_ZONE_MEMORY_TTL + 1,
      map: { findRoute } as unknown as GameMap,
      rooms: {}
    };

    expect(hasSafeRouteAvoidingDeadZones('W1N1', 'W3N1')).toBe(true);
    expect(Memory.defense?.unsafeRooms?.W2N1).toMatchObject({
      roomName: 'W2N1',
      updatedAt: 100
    });
  });
});

function makeUnsafeRoomMemory(roomName: string, updatedAt: number): DefenseUnsafeRoomMemory {
  return {
    roomName,
    unsafe: true,
    reason: 'enemyTower',
    updatedAt,
    hostileCreepCount: 0,
    hostileStructureCount: 1,
    hostileTowerCount: 1
  };
}

function makeRoom(roomName: string, hostileStructures: Structure[] = []): Room {
  return {
    name: roomName,
    find: jest.fn((type: number) => {
      if (type === TEST_GLOBALS.FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeHostileTower(id: string, roomName: string): Structure {
  return {
    id,
    structureType: TEST_GLOBALS.STRUCTURE_TOWER,
    pos: { roomName }
  } as unknown as Structure;
}
