import {
  CROSS_ROOM_HAULER_ROLE,
  planCrossRoomHauler,
  selectCrossRoomEnergyTransfer
} from '../../src/economy/crossRoomHauler';
import { balanceStorage } from '../../src/economy/storageBalancer';

const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;

describe('economy inter-room energy transfers', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      ERR_NO_PATH: ERR_NO_PATH_CODE,
      FIND_HOSTILE_CREEPS: 1,
      FIND_HOSTILE_STRUCTURES: 2,
      FIND_MY_STRUCTURES: 3,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_EXTENSION: 'extension',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_STORAGE: 'storage',
      STRUCTURE_TERMINAL: 'terminal',
      STRUCTURE_TOWER: 'tower'
    });
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
    delete (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
    delete (globalThis as { STRUCTURE_EXTENSION?: StructureConstant }).STRUCTURE_EXTENSION;
    delete (globalThis as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN;
    delete (globalThis as { STRUCTURE_STORAGE?: StructureConstant }).STRUCTURE_STORAGE;
    delete (globalThis as { STRUCTURE_TERMINAL?: StructureConstant }).STRUCTURE_TERMINAL;
    delete (globalThis as { STRUCTURE_TOWER?: StructureConstant }).STRUCTURE_TOWER;
  });

  it('identifies surplus and deficit rooms and assigns a cross-room hauler transfer', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 900 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 200 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, targetRoom], [sourceSpawn]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.W1N1).toMatchObject({
      mode: 'export',
      exportableEnergy: 100
    });
    expect(Memory.economy?.storageBalance?.rooms.W2N1).toMatchObject({
      mode: 'import',
      importDemand: 100
    });
    expect(selectCrossRoomEnergyTransfer()).toEqual({
      sourceRoom: 'W1N1',
      targetRoom: 'W2N1',
      amount: 100,
      updatedAt: 100
    });
    expect(planCrossRoomHauler()).toMatchObject({
      memory: {
        role: CROSS_ROOM_HAULER_ROLE,
        colony: 'W1N1',
        crossRoomHauler: {
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          sourceId: 'W1N1-storage',
          state: 'collecting',
          route: ['W2N1']
        }
      }
    });
  });

  it('routes energy into a storage-starved room from neighboring high-energy rooms below the ratio export threshold', () => {
    const importerRoom = makeOwnedRoom({
      roomName: 'E29N55',
      storageEnergy: 5_221,
      storageCapacity: 1_000_000
    });
    const sourceRoomA = makeOwnedRoom({
      roomName: 'E29N56',
      storageEnergy: 301_484,
      storageCapacity: 1_000_000
    });
    const sourceRoomB = makeOwnedRoom({
      roomName: 'E29N57',
      storageEnergy: 367_179,
      storageCapacity: 1_000_000
    });
    const sourceSpawnA = makeSpawn('SpawnE29N56', sourceRoomA);
    const sourceSpawnB = makeSpawn('SpawnE29N57', sourceRoomB);
    installGame(
      [importerRoom, sourceRoomA, sourceRoomB],
      [sourceSpawnA, sourceSpawnB]
    );

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.E29N55).toMatchObject({
      mode: 'import',
      importDemand: 294_779
    });
    expect(Memory.economy?.storageBalance?.rooms.E29N56).toMatchObject({
      mode: 'balanced',
      exportableEnergy: 0
    });
    expect(Memory.economy?.storageBalance?.rooms.E29N57).toMatchObject({
      mode: 'balanced',
      exportableEnergy: 0
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E29N57', targetRoom: 'E29N55', amount: 267_179, updatedAt: 100 },
      { sourceRoom: 'E29N56', targetRoom: 'E29N55', amount: 27_600, updatedAt: 100 }
    ]);
    expect(Memory.economy?.multiRoomEnergy?.rooms.E29N55).toMatchObject({
      plannedImportEnergy: 294_779,
      blockedImportEnergy: 0
    });
    expect(Memory.economy?.multiRoomEnergy?.rooms.E29N55?.bottleneck).toBeUndefined();
    expect(planCrossRoomHauler()?.memory.crossRoomHauler).toMatchObject({
      homeRoom: 'E29N57',
      targetRoom: 'E29N55'
    });
  });

  it('allows Seasonal inter-room energy imports into owned rooms below RCL3', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', controllerLevel: 3, storageEnergy: 900 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', controllerLevel: 2, storageEnergy: 200 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, targetRoom], [sourceSpawn], { shardName: 'shardSeason' });

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 100, updatedAt: 100 }
    ]);
    expect(selectCrossRoomEnergyTransfer()?.targetRoom).toBe('W2N1');
  });

  it('does not create Seasonal inter-room energy transfers between RCL3+ owned rooms', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', controllerLevel: 3, storageEnergy: 900 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', controllerLevel: 3, storageEnergy: 200 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, targetRoom], [sourceSpawn], { shardName: 'shardSeason' });

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([]);
    expect(Memory.economy?.multiRoomEnergy?.transfers).toContainEqual({
      targetRoom: 'W2N1',
      amount: 100,
      status: 'blocked',
      reason: 'no-exporter',
      updatedAt: 100
    });
    expect(planCrossRoomHauler()).toBeNull();
  });

  it('orders inter-room imports by critical spawn pressure before controller upgrade and routine deficits', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'W1N1',
      storageEnergy: 2_000,
      storageCapacity: 2_000
    });
    const criticalSpawnRoom = makeOwnedRoom({
      roomName: 'W2N1',
      energyAvailable: 100,
      energyCapacityAvailable: 800,
      storageEnergy: 100
    });
    const controllerUpgradeRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 100 });
    const routineRoom = makeOwnedRoom({ roomName: 'W4N1', storageEnergy: 100 });
    installGame(
      [sourceRoom, criticalSpawnRoom, controllerUpgradeRoom, routineRoom],
      [makeSpawn('Spawn1', sourceRoom), makeSpawn('Spawn2', criticalSpawnRoom)]
    );
    Memory.territory = {
      controllers: {
        W3N1: {
          activeUpgraderCount: 0,
          controllerId: 'W3N1-controller' as Id<StructureController>,
          desiredUpgraderCount: 1,
          roomName: 'W3N1',
          signNeeded: false,
          updatedAt: 100,
          upgradePriority: 'rclProgress'
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 600, updatedAt: 100 }
    ]);
    expect(selectCrossRoomEnergyTransfer()?.targetRoom).toBe('W2N1');
  });
});

function makeOwnedRoom({
  roomName,
  storageEnergy,
  storageCapacity = 1_000,
  energyAvailable = 800,
  energyCapacityAvailable = 800,
  controllerLevel = 4
}: {
  roomName: string;
  storageEnergy: number;
  storageCapacity?: number;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  controllerLevel?: number;
}): Room {
  const controller = {
    id: `${roomName}-controller`,
    my: true,
    level: controllerLevel
  } as StructureController;
  return {
    name: roomName,
    controller,
    energyAvailable,
    energyCapacityAvailable,
    memory: {},
    storage: makeStorage(`${roomName}-storage`, storageEnergy, storageCapacity, roomName),
    find: jest.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES || type === FIND_MY_STRUCTURES) {
        return [];
      }

      return [];
    })
  } as unknown as Room;
}

function makeSpawn(name: string, room: Room): StructureSpawn {
  return {
    id: name,
    name,
    room,
    pos: makeRoomPosition(10, 10, room.name),
    structureType: 'spawn',
    spawning: null,
    store: makeStore(300, 300)
  } as unknown as StructureSpawn;
}

function makeStorage(id: string, energy: number, capacity: number, roomName: string): StructureStorage {
  return {
    id,
    pos: makeRoomPosition(12, 10, roomName),
    structureType: 'storage',
    store: makeStore(energy, capacity)
  } as unknown as StructureStorage;
}

function makeStore(energy: number, capacity: number): StoreDefinition {
  return {
    getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? capacity : 0)),
    getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
      resource === RESOURCE_ENERGY ? Math.max(0, capacity - energy) : 0
    ),
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0))
  } as unknown as StoreDefinition;
}

function makeRoomPosition(x: number, y: number, roomName: string): RoomPosition {
  return {
    x,
    y,
    roomName,
    getRangeTo: jest.fn((target: RoomObject | RoomPosition) => {
      const position = 'pos' in target ? target.pos : target;
      return Math.max(Math.abs(x - position.x), Math.abs(y - position.y));
    })
  } as unknown as RoomPosition;
}

function installGame(
  rooms: Room[],
  spawns: StructureSpawn[],
  options: { shardName?: string } = {}
): void {
  (globalThis as { Game: Partial<Game> }).Game = {
    time: 100,
    ...(options.shardName ? { shard: { name: options.shardName, type: 'normal' } as Game['shard'] } : {}),
    creeps: {},
    rooms: Object.fromEntries(rooms.map((room) => [room.name, room])),
    spawns: Object.fromEntries(spawns.map((spawn) => [spawn.name, spawn])),
    map: {
      findRoute: jest.fn((_fromRoom: string, targetRoom: string, options?: { routeCallback?: (roomName: string) => number }) => {
        if (options?.routeCallback?.(targetRoom) === Infinity) {
          return ERR_NO_PATH_CODE;
        }

        return [{ exit: 1, room: targetRoom }];
      })
    } as unknown as GameMap
  };
  (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
}
