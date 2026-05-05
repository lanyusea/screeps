import { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  CROSS_ROOM_HAULER_ROLE,
  buildCrossRoomHaulerBody,
  planCrossRoomHauler,
  runCrossRoomHauler
} from '../src/economy/crossRoomHauler';
import { balanceStorage } from '../src/economy/storageBalancer';
import {
  getSpawnEnergyForecast,
  orderColoniesForSpawnPlanning,
  planSpawn
} from '../src/spawn/spawnPlanner';

describe('cross-room energy logistics', () => {
  const OK_CODE = 0 as ScreepsReturnCode;
  const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
  const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
  const objectRegistry = new Map<string, unknown>();

  beforeEach(() => {
    objectRegistry.clear();
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 1;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 5;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { ERR_NOT_IN_RANGE: ScreepsReturnCode }).ERR_NOT_IN_RANGE = ERR_NOT_IN_RANGE_CODE;
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = ERR_NO_PATH_CODE;
    (globalThis as unknown as { RoomPosition: new (x: number, y: number, roomName: string) => RoomPosition })
      .RoomPosition = class {
      public constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly roomName: string
      ) {}
    } as unknown as new (x: number, y: number, roomName: string) => RoomPosition;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('flags export and import rooms from storage thresholds', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 900 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 200 });
    const balancedRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 500 });
    installGame([sourceRoom, targetRoom, balancedRoom], []);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.W1N1).toMatchObject({
      mode: 'export',
      energy: 900,
      capacity: 1_000,
      exportableEnergy: 100
    });
    expect(Memory.economy?.storageBalance?.rooms.W2N1).toMatchObject({
      mode: 'import',
      importDemand: 100
    });
    expect(Memory.economy?.storageBalance?.rooms.W3N1).toMatchObject({ mode: 'balanced' });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 100, updatedAt: 100 }
    ]);
  });

  it('plans a proportional CARRY/MOVE hauler from a surplus room to a deficit room', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 800 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, targetRoom], [sourceSpawn]);
    balanceStorage();

    const plan = planCrossRoomHauler();

    expect(plan).toMatchObject({
      spawn: sourceSpawn,
      body: ['carry', 'move', 'carry', 'move', 'carry', 'move'],
      name: 'crossRoomHauler-W1N1-W2N1-100',
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
    expect(buildCrossRoomHaulerBody(800, 150)).toEqual(plan?.body);
  });

  it('plans cross-room hauling through neutral transit rooms', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 800 });
    const transitRoom = makeNeutralRoom('W2N1');
    const targetRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 100 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, transitRoom, targetRoom], [sourceSpawn], {}, (fromRoom, toRoom, options) => {
      const route = [
        { exit: 1, room: 'W2N1' },
        { exit: 1, room: toRoom }
      ];
      if (route.some((step) => options?.routeCallback?.(step.room, fromRoom) === Infinity)) {
        return ERR_NO_PATH_CODE;
      }

      return route;
    });
    balanceStorage();

    const plan = planCrossRoomHauler();

    expect(plan?.memory.crossRoomHauler?.route).toEqual(['W2N1', 'W3N1']);
  });

  it('does nothing when all owned rooms are balanced', () => {
    const roomA = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 500 });
    const roomB = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 400 });
    installGame([roomA, roomB], [makeSpawn('Spawn1', roomA), makeSpawn('Spawn2', roomB)]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([]);
    expect(planCrossRoomHauler()).toBeNull();
  });

  it('degrades to no-op when only one room is owned', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    installGame([sourceRoom], [makeSpawn('Spawn1', sourceRoom)]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.W1N1?.mode).toBe('export');
    expect(Memory.economy?.storageBalance?.transfers).toEqual([]);
    expect(planCrossRoomHauler()).toBeNull();
  });

  it('rejects cross-room hauling through hostile owned rooms', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const hostileTransitRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 500,
      hostileCreeps: [{} as Creep]
    });
    const targetRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 100 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, hostileTransitRoom, targetRoom], [sourceSpawn], {}, (fromRoom, toRoom, options) => {
      const route = [
        { exit: 1, room: 'W2N1' },
        { exit: 1, room: toRoom }
      ];
      if (route.some((step) => options?.routeCallback?.(step.room, fromRoom) === Infinity)) {
        return ERR_NO_PATH_CODE;
      }

      return route;
    });
    balanceStorage();

    expect(planCrossRoomHauler()).toBeNull();
  });

  it('suppresses routine worker spawning in an importing deficit room', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100, energyAvailable: 300 });
    const targetSpawn = makeSpawn('Spawn2', targetRoom);
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom), targetSpawn]);
    balanceStorage();
    const targetColony = makeColony(targetRoom, [targetSpawn]);

    expect(planSpawn(targetColony, { worker: 3, workerCapacity: 2 }, 101)).toBeNull();
  });

  it('keeps worker recovery active in importing rooms with zero worker capacity', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100, energyAvailable: 300 });
    const targetSpawn = makeSpawn('Spawn2', targetRoom);
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom), targetSpawn]);
    balanceStorage();
    const targetColony = makeColony(targetRoom, [targetSpawn]);

    expect(planSpawn(targetColony, { worker: 3, workerCapacity: 0 }, 102)).toEqual({
      spawn: targetSpawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W2N1-102',
      memory: { role: 'worker', colony: 'W2N1' }
    });
  });

  it('does not suppress local workers for impossible cross-room transfer lanes', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100, energyAvailable: 300 });
    const targetSpawn = makeSpawn('Spawn2', targetRoom);
    installGame(
      [sourceRoom, targetRoom],
      [makeSpawn('Spawn1', sourceRoom), targetSpawn],
      {},
      () => ERR_NO_PATH_CODE
    );
    balanceStorage();
    const targetColony = makeColony(targetRoom, [targetSpawn]);

    expect(planSpawn(targetColony, { worker: 3, workerCapacity: 2 }, 103)).toEqual({
      spawn: targetSpawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W2N1-103',
      memory: { role: 'worker', colony: 'W2N1' }
    });
  });

  it('orders spawn planning by effective energy after planned transfers', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 900 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100, energyAvailable: 300 });
    const balancedRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 500, energyAvailable: 500 });
    installGame([sourceRoom, targetRoom, balancedRoom], []);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        storageBalance: {
          updatedAt: 100,
          rooms: {},
          transfers: [{ sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 600, updatedAt: 100 }]
        }
      }
    };
    const colonies = [
      makeColony(sourceRoom),
      makeColony(targetRoom),
      makeColony(balancedRoom)
    ];

    expect(getSpawnEnergyForecast(colonies[0])).toMatchObject({
      roomName: 'W1N1',
      effectiveEnergyAvailable: 300
    });
    expect(orderColoniesForSpawnPlanning(colonies).map((colony) => colony.room.name)).toEqual([
      'W2N1',
      'W3N1',
      'W1N1'
    ]);
  });

  it('withdraws from the source room and delivers to spawn energy demand', () => {
    let carriedEnergy = 0;
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetOwnedStructures: AnyOwnedStructure[] = [];
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 100,
      myStructures: targetOwnedStructures
    });
    const targetSpawn = makeSpawn('Spawn2', targetRoom, 300);
    targetOwnedStructures.push(targetSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [targetSpawn]);
    const creep = makeCrossRoomHauler({
      room: sourceRoom,
      carriedEnergy: () => carriedEnergy,
      withdraw: jest.fn(() => {
        carriedEnergy = 100;
        return OK_CODE;
      }),
      transfer: jest.fn(() => {
        carriedEnergy = 0;
        return OK_CODE;
      })
    });

    runCrossRoomHauler(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(sourceRoom.storage, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'W1N1-storage' });

    creep.room = targetRoom;
    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(targetSpawn, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'Spawn2' });
  });

  it('falls back to deficit-room containers when spawn and extensions are full', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const container = makeContainer('W2N1-container', 0, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 100,
      structures: [container]
    });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'W2N1-container' });
  });

  it('delivers to deficit-room storage when transient sinks are unavailable', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(targetRoom.storage, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'W2N1-storage' });
  });

  it('delivers to deficit-room terminal when storage is full', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 1_000,
      terminalEnergy: 100,
      terminalCapacity: 1_000
    });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(targetRoom.terminal, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'W2N1-terminal' });
  });

  it('returns home when empty and the source room no longer has surplus', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 700 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    installGame([sourceRoom, targetRoom], []);
    const moveTo = jest.fn();
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 0,
      moveTo
    });

    runCrossRoomHauler(creep);

    expect(creep.memory.crossRoomHauler?.state).toBe('returning');
    expect(moveTo).toHaveBeenCalledWith(sourceRoom.controller, { reusePath: 20, ignoreRoads: false });
  });

  function makeOwnedRoom({
    roomName,
    storageEnergy,
    storageCapacity = 1_000,
    terminalEnergy = 0,
    terminalCapacity = 0,
    energyAvailable = 800,
    energyCapacityAvailable = 800,
    myStructures = [],
    structures = [],
    hostileCreeps = [],
    hostileStructures = []
  }: {
    roomName: string;
    storageEnergy: number;
    storageCapacity?: number;
    terminalEnergy?: number;
    terminalCapacity?: number;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    myStructures?: AnyOwnedStructure[];
    structures?: Structure[];
    hostileCreeps?: Creep[];
    hostileStructures?: Structure[];
  }): Room {
    const controller = { id: `${roomName}-controller`, my: true, level: 4 } as StructureController;
    registerObject(controller);
    const room = {
      name: roomName,
      energyAvailable,
      energyCapacityAvailable,
      controller,
      memory: {},
      storage: makeStorage(`${roomName}-storage`, storageEnergy, storageCapacity),
      ...(terminalCapacity > 0 ? { terminal: makeTerminal(`${roomName}-terminal`, terminalEnergy, terminalCapacity) } : {}),
      find: jest.fn((type: number) => {
        if (type === FIND_MY_STRUCTURES) {
          return myStructures;
        }

        if (type === FIND_STRUCTURES) {
          return structures;
        }

        if (type === FIND_HOSTILE_CREEPS) {
          return hostileCreeps;
        }

        if (type === FIND_HOSTILE_STRUCTURES) {
          return hostileStructures;
        }

        if (type === FIND_SOURCES) {
          return [{ id: `${roomName}-source` } as Source];
        }

        return [];
      })
    } as unknown as Room;

    return room;
  }

  function makeNeutralRoom(roomName: string): Room {
    const controller = { id: `${roomName}-controller`, my: false } as StructureController;
    registerObject(controller);
    const room = {
      name: roomName,
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller,
      memory: {},
      find: jest.fn(() => [])
    } as unknown as Room;

    return room;
  }

  function makeColony(room: Room, spawns: StructureSpawn[] = []): ColonySnapshot {
    return {
      room,
      spawns,
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable
    };
  }

  function makeSpawn(name: string, room: Room, freeCapacity = 0): StructureSpawn {
    const spawn = {
      id: name,
      name,
      room,
      structureType: 'spawn',
      spawning: null,
      store: makeStore(300 - freeCapacity, 300)
    } as unknown as StructureSpawn;
    registerObject(spawn);
    return spawn;
  }

  function makeContainer(id: string, energy: number, capacity: number): StructureContainer {
    const container = {
      id,
      structureType: 'container',
      store: makeStore(energy, capacity)
    } as unknown as StructureContainer;
    registerObject(container);
    return container;
  }

  function makeStorage(id: string, energy: number, capacity: number): StructureStorage {
    const storage = {
      id,
      structureType: 'storage',
      store: makeStore(energy, capacity)
    } as unknown as StructureStorage;
    registerObject(storage);
    return storage;
  }

  function makeTerminal(id: string, energy: number, capacity: number): StructureTerminal {
    const terminal = {
      id,
      structureType: 'terminal',
      store: makeStore(energy, capacity)
    } as unknown as StructureTerminal;
    registerObject(terminal);
    return terminal;
  }

  function makeStore(energy: number, capacity: number): StoreDefinition {
    return {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
      getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? capacity : 0)),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? Math.max(0, capacity - energy) : 0
      )
    } as unknown as StoreDefinition;
  }

  function makeCrossRoomHauler({
    room,
    carriedEnergy,
    withdraw = jest.fn(() => OK_CODE),
    transfer = jest.fn(() => OK_CODE),
    moveTo = jest.fn()
  }: {
    room: Room;
    carriedEnergy: () => number;
    withdraw?: jest.Mock;
    transfer?: jest.Mock;
    moveTo?: jest.Mock;
  }): Creep {
    return {
      room,
      memory: {
        role: CROSS_ROOM_HAULER_ROLE,
        colony: 'W1N1',
        crossRoomHauler: {
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          sourceId: 'W1N1-storage' as Id<AnyStoreStructure>,
          state: 'collecting',
          route: ['W2N1']
        }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? carriedEnergy() : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 200 - carriedEnergy() : 0))
      },
      withdraw,
      transfer,
      moveTo
    } as unknown as Creep;
  }

  function installGame(
    rooms: Room[],
    spawns: StructureSpawn[],
    creeps: Record<string, Creep> = {},
    findRoute: (
      fromRoom: string,
      toRoom: string,
      options?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
    ) => unknown = (_fromRoom, toRoom, options) => {
      if (options?.routeCallback?.(toRoom, _fromRoom) === Infinity) {
        return ERR_NO_PATH_CODE;
      }

      return [{ exit: 1, room: toRoom }];
    }
  ): void {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100,
      rooms: Object.fromEntries(rooms.map((room) => [room.name, room])),
      spawns: Object.fromEntries(spawns.map((spawn) => [spawn.name, spawn])),
      creeps,
      getObjectById: jest.fn((id: string) => objectRegistry.get(id) ?? null) as Game['getObjectById'],
      map: { findRoute } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  }

  function registerObject(object: { id?: string }): void {
    if (typeof object.id === 'string') {
      objectRegistry.set(object.id, object);
    }
  }
});
