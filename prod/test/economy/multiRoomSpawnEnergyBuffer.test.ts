import {
  CROSS_ROOM_HAULER_ROLE,
  planCrossRoomHauler,
  runCrossRoomHauler
} from '../../src/economy/crossRoomHauler';
import { balanceStorage } from '../../src/economy/storageBalancer';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;

describe('multi-room spawn energy buffer coordination', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      ERR_NO_PATH: ERR_NO_PATH_CODE,
      FIND_HOSTILE_CREEPS: 1,
      FIND_HOSTILE_STRUCTURES: 2,
      FIND_MY_STRUCTURES: 3,
      FIND_STRUCTURES: 4,
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
  });

  it('tracks spawn buffer deficits across owned rooms', () => {
    const sourceStructures: AnyOwnedStructure[] = [];
    const targetStructures: AnyOwnedStructure[] = [];
    const sourceRoom = makeOwnedRoom({
      roomName: 'E24S49',
      storageEnergy: 2_000,
      storageCapacity: 2_000,
      energyAvailable: 800,
      myStructures: sourceStructures
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S47',
      storageEnergy: 500,
      storageCapacity: 1_000,
      energyAvailable: 100,
      myStructures: targetStructures
    });
    sourceStructures.push(makeSpawn('SpawnE24S49', sourceRoom, 0) as unknown as AnyOwnedStructure);
    targetStructures.push(makeSpawn('SpawnE26S47', targetRoom, 200) as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], sourceStructures.concat(targetStructures) as unknown as StructureSpawn[]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.E26S47).toMatchObject({
      mode: 'import',
      importDemand: 400,
      spawnEnergyAvailable: 100,
      spawnEnergyBufferThreshold: 500,
      spawnEnergyBufferDeficit: 400,
      criticalSpawnEnergyDeficit: 200
    });
    expect(Memory.economy?.multiRoomEnergy?.rooms.E26S47).toMatchObject({
      plannedImportEnergy: 400,
      spawnEnergyAvailable: 100,
      spawnEnergyBufferThreshold: 500,
      spawnEnergyBufferDeficit: 400,
      criticalSpawnEnergyDeficit: 200,
      storageDeficit: 0,
      deficitEnergy: 0
    });
  });

  it('imports for active spawn reservations in rooms without local spawns', () => {
    const sourceStructures: AnyOwnedStructure[] = [];
    const sourceRoom = makeOwnedRoom({
      roomName: 'E24S49',
      storageEnergy: 2_000,
      storageCapacity: 2_000,
      energyAvailable: 800,
      myStructures: sourceStructures
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S47',
      storageEnergy: 500,
      storageCapacity: 1_000,
      energyAvailable: 200
    });
    const sourceSpawn = makeSpawn('SpawnE24S49', sourceRoom, 0);
    sourceStructures.push(sourceSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [sourceSpawn]);
    Memory.economy = {
      spawnEnergyReservation: {
        updatedAt: 99,
        rooms: {
          E26S47: {
            bodyCost: 650,
            creepName: 'worker-E26S47-100',
            reservedAt: 99,
            reservedEnergy: 650,
            role: 'worker',
            roomName: 'E26S47',
            updatedAt: 99
          }
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.E26S47).toMatchObject({
      importDemand: 450,
      reservedSpawnEnergy: 650,
      spawnEnergyBufferThreshold: 650,
      spawnEnergyBufferDeficit: 450,
      unmetSpawnEnergyReservation: 450
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E24S49', targetRoom: 'E26S47', amount: 450, updatedAt: 100 }
    ]);
    expect(Memory.economy?.multiRoomEnergy?.rooms.E26S47).toMatchObject({
      plannedImportEnergy: 450,
      spawnEnergyBufferThreshold: 650,
      spawnEnergyBufferDeficit: 450,
      storageDeficit: 0,
      deficitEnergy: 0
    });
    expect(Memory.economy?.multiRoomEnergy?.transfers).toContainEqual({
      sourceRoom: 'E24S49',
      targetRoom: 'E26S47',
      amount: 450,
      status: 'planned',
      reason: 'spawn-energy-buffer',
      updatedAt: 100
    });
  });

  it('routes cross-room energy for post-claim spawn construction without a local spawn', () => {
    const sourceStructures: AnyOwnedStructure[] = [];
    const sourceRoom = makeOwnedRoom({
      roomName: 'E24S49',
      storageEnergy: 2_000,
      storageCapacity: 2_000,
      energyAvailable: 800,
      myStructures: sourceStructures
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'E24S48',
      storageEnergy: 100,
      storageCapacity: 1_000,
      energyAvailable: 0
    });
    const sourceSpawn = makeSpawn('SpawnE24S49', sourceRoom, 0);
    sourceStructures.push(sourceSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [sourceSpawn]);
    Memory.territory = {
      postClaimBootstraps: {
        E24S48: {
          colony: 'E24S49',
          roomName: 'E24S48',
          status: 'spawnSitePending',
          claimedAt: 786700,
          updatedAt: 786805,
          workerTarget: 2,
          spawnSite: { roomName: 'E24S48', x: 23, y: 23 }
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.E24S48).toMatchObject({
      mode: 'import',
      importDemand: 500
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E24S49', targetRoom: 'E24S48', amount: 500, updatedAt: 100 }
    ]);
    expect(Memory.economy?.multiRoomEnergy?.transfers).toContainEqual({
      sourceRoom: 'E24S49',
      targetRoom: 'E24S48',
      amount: 500,
      status: 'planned',
      reason: 'post-claim-spawn-construction',
      updatedAt: 100
    });
    expect(planCrossRoomHauler()?.memory.crossRoomHauler).toMatchObject({
      homeRoom: 'E24S49',
      targetRoom: 'E24S48'
    });
  });

  it('keeps reservation-driven spawn buffer deficits from being subtracted twice from exports', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'E24S49',
      storageEnergy: 1_000,
      storageCapacity: 1_000,
      energyAvailable: 700
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S47',
      storageEnergy: 200,
      storageCapacity: 1_000
    });
    installGame([sourceRoom, targetRoom], []);
    Memory.economy = {
      spawnEnergyReservation: {
        updatedAt: 99,
        rooms: {
          E24S49: {
            bodyCost: 800,
            creepName: 'claimer-E24S49-E26S47-100',
            reservedAt: 99,
            reservedEnergy: 800,
            role: 'claimer',
            roomName: 'E24S49',
            updatedAt: 99
          }
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.E24S49).toMatchObject({
      mode: 'export',
      exportableEnergy: 100,
      reservedSpawnEnergy: 800,
      spawnEnergyBufferDeficit: 100,
      unmetSpawnEnergyReservation: 100
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E24S49', targetRoom: 'E26S47', amount: 100, updatedAt: 100 }
    ]);
  });

  it('routes cross-room energy to replenish a critically low spawn buffer', () => {
    const sourceStructures: AnyOwnedStructure[] = [];
    const targetStructures: AnyOwnedStructure[] = [];
    const sourceRoom = makeOwnedRoom({
      roomName: 'E24S49',
      storageEnergy: 2_000,
      storageCapacity: 2_000,
      energyAvailable: 800,
      myStructures: sourceStructures
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S47',
      storageEnergy: 500,
      storageCapacity: 1_000,
      energyAvailable: 100,
      myStructures: targetStructures
    });
    const sourceSpawn = makeSpawn('SpawnE24S49', sourceRoom, 0);
    const targetSpawn = makeSpawn('SpawnE26S47', targetRoom, 200);
    sourceStructures.push(sourceSpawn as unknown as AnyOwnedStructure);
    targetStructures.push(targetSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [sourceSpawn, targetSpawn]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E24S49', targetRoom: 'E26S47', amount: 400, updatedAt: 100 }
    ]);
    expect(Memory.economy?.multiRoomEnergy?.transfers).toContainEqual({
      sourceRoom: 'E24S49',
      targetRoom: 'E26S47',
      amount: 400,
      status: 'planned',
      reason: 'spawn-energy-buffer',
      updatedAt: 100
    });
    expect(planCrossRoomHauler()).toMatchObject({
      spawn: sourceSpawn,
      memory: {
        role: CROSS_ROOM_HAULER_ROLE,
        colony: 'E24S49',
        crossRoomHauler: {
          homeRoom: 'E24S49',
          targetRoom: 'E26S47',
          sourceId: 'E24S49-storage',
          route: ['E26S47']
        }
      }
    });
  });

  it('uses balanced-room reserve energy above the import floor for spawn buffer imports', () => {
    const sourceStructures: AnyOwnedStructure[] = [];
    const targetStructures: AnyOwnedStructure[] = [];
    const sourceRoom = makeOwnedRoom({
      roomName: 'E24S49',
      storageEnergy: 700,
      storageCapacity: 1_000,
      energyAvailable: 800,
      myStructures: sourceStructures
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S47',
      storageEnergy: 500,
      storageCapacity: 1_000,
      energyAvailable: 100,
      myStructures: targetStructures
    });
    const sourceSpawn = makeSpawn('SpawnE24S49', sourceRoom, 0);
    const targetSpawn = makeSpawn('SpawnE26S47', targetRoom, 200);
    sourceStructures.push(sourceSpawn as unknown as AnyOwnedStructure);
    targetStructures.push(targetSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [sourceSpawn, targetSpawn]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.E24S49).toMatchObject({
      mode: 'balanced',
      exportableEnergy: 0
    });
    expect(Memory.economy?.storageBalance?.rooms.E26S47).toMatchObject({
      spawnEnergyBufferDeficit: 400,
      importDemand: 400
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E24S49', targetRoom: 'E26S47', amount: 400, updatedAt: 100 }
    ]);
    expect(planCrossRoomHauler()).toMatchObject({
      spawn: sourceSpawn,
      body: [
        'carry',
        'move',
        'carry',
        'move',
        'carry',
        'move',
        'carry',
        'move',
        'carry',
        'move',
        'carry',
        'move',
        'carry',
        'move',
        'carry',
        'move'
      ],
      memory: {
        crossRoomHauler: {
          homeRoom: 'E24S49',
          targetRoom: 'E26S47'
        }
      }
    });
  });

  it('delivers imported energy to the empty room spawn before durable storage', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'E24S49',
      storageEnergy: 2_000,
      storageCapacity: 2_000,
      energyAvailable: 800
    });
    const targetStructures: AnyOwnedStructure[] = [];
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S47',
      storageEnergy: 500,
      storageCapacity: 1_000,
      energyAvailable: 0,
      myStructures: targetStructures
    });
    const targetSpawn = makeSpawn('SpawnE26S47', targetRoom, 300);
    targetStructures.push(targetSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [targetSpawn]);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(targetSpawn, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'SpawnE26S47' });
  });

  it('does not create cross-room spawn-buffer transfers for a single owned room', () => {
    const structures: AnyOwnedStructure[] = [];
    const room = makeOwnedRoom({
      roomName: 'E26S47',
      storageEnergy: 500,
      storageCapacity: 1_000,
      energyAvailable: 0,
      myStructures: structures
    });
    const spawn = makeSpawn('SpawnE26S47', room, 300);
    structures.push(spawn as unknown as AnyOwnedStructure);
    installGame([room], [spawn]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.E26S47).toMatchObject({
      spawnEnergyBufferDeficit: 500
    });
    expect(Memory.economy?.multiRoomEnergy?.rooms.E26S47).toMatchObject({
      spawnEnergyBufferDeficit: 500,
      storageDeficit: 500,
      deficitEnergy: 500
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([]);
    expect(planCrossRoomHauler()).toBeNull();
  });
});

function makeOwnedRoom({
  roomName,
  storageEnergy,
  storageCapacity = 1_000,
  energyAvailable = 800,
  energyCapacityAvailable = 800,
  myStructures = []
}: {
  roomName: string;
  storageEnergy: number;
  storageCapacity?: number;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  myStructures?: AnyOwnedStructure[];
}): Room {
  return {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    controller: { id: `${roomName}-controller`, my: true, level: 4 } as StructureController,
    memory: {},
    storage: makeStorage(`${roomName}-storage`, storageEnergy, storageCapacity, roomName),
    find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        return options?.filter ? myStructures.filter(options.filter) : myStructures;
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES || type === FIND_STRUCTURES) {
        return [];
      }

      return [];
    })
  } as unknown as Room;
}

function makeSpawn(name: string, room: Room, freeCapacity: number): StructureSpawn {
  return {
    id: name,
    name,
    room,
    pos: makeRoomPosition(10, 10, room.name),
    structureType: 'spawn',
    spawning: null,
    store: makeStore(300 - freeCapacity, 300)
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

function makeCrossRoomHauler({
  room,
  carriedEnergy,
  transfer = jest.fn(() => OK_CODE)
}: {
  room: Room;
  carriedEnergy: () => number;
  transfer?: jest.Mock;
}): Creep {
  return {
    pos: makeRoomPosition(1, 1, room.name),
    room,
    memory: {
      role: CROSS_ROOM_HAULER_ROLE,
      colony: 'E24S49',
      crossRoomHauler: {
        homeRoom: 'E24S49',
        targetRoom: 'E26S47',
        sourceId: 'E24S49-storage' as Id<AnyStoreStructure>,
        state: 'delivering',
        route: ['E26S47']
      }
    },
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? carriedEnergy() : 0)),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 200 - carriedEnergy() : 0))
    },
    transfer,
    moveTo: jest.fn()
  } as unknown as Creep;
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

function installGame(rooms: Room[], spawns: StructureSpawn[]): void {
  (globalThis as { Game: Partial<Game> }).Game = {
    time: 100,
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
