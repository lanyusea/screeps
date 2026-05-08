import { runEconomy } from '../src/economy/economyLoop';
import { SPAWN_ENERGY_RESERVATION_IDLE_RELEASE_TICKS } from '../src/economy/spawnEnergyReservation';
import { MIN_SPAWN_ENERGY_BUFFER } from '../src/spawn/spawnConfig';
import { CONTROLLER_DOWNGRADE_GUARD_TICKS } from '../src/tasks/workerTasks';
import { RUNTIME_SUMMARY_PREFIX } from '../src/telemetry/runtimeSummary';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_BUSY_CODE = -4 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const SCALED_WORKER_800: BodyPartConstant[] = [
  'work',
  'work',
  'work',
  'carry',
  'carry',
  'move',
  'move',
  'move'
];

describe('runEconomy', () => {
  let logSpy: jest.SpyInstance<void, [message?: unknown, ...optionalParams: unknown[]]>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('spawns a worker request for an owned colony below target workers', () => {
    const room = { name: 'W1N1', energyAvailable: 300, energyCapacityAvailable: 300 } as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 123,
      rooms: {
        W1N1: { ...room, controller: { my: true } as StructureController } as Room
      },
      spawns: { Spawn1: spawn },
      creeps: {}
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-123', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('spawns an emergency bootstrap worker without requiring the energy buffer', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 200,
      energyCapacityAvailable: 400,
      controller: { my: true } as StructureController
    } as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 125,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {}
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-125', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(logSpy).not.toHaveBeenCalledWith(
      `[spawn] warning: deferred worker-W1N1-125 in W1N1; available energy 200, body cost 200, required buffer ${MIN_SPAWN_ENERGY_BUFFER}`
    );
  });

  it('spawns an emergency bootstrap worker when the energy buffer is satisfied', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 200 + MIN_SPAWN_ENERGY_BUFFER,
      energyCapacityAvailable: 400,
      controller: { my: true } as StructureController
    } as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 125,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {}
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-125', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('uses multiple idle spawns in one tick when worker recovery has enough room energy', () => {
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 4;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const ownedStructures: AnyOwnedStructure[] = [];
    const room = {
      name: 'W1N1',
      energyAvailable: 1200,
      energyCapacityAvailable: 1200,
      controller: { my: true } as StructureController,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          return options?.filter ? ownedStructures.filter(options.filter) : ownedStructures;
        }

        return [];
      })
    } as unknown as Room;
    const spawn1 = {
      id: 'spawn1',
      name: 'Spawn1',
      room,
      structureType: 'spawn',
      spawning: null,
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) },
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    const spawn2 = {
      id: 'spawn2',
      name: 'Spawn2',
      room,
      structureType: 'spawn',
      spawning: null,
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) },
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    ownedStructures.push(spawn1 as unknown as AnyOwnedStructure, spawn2 as unknown as AnyOwnedStructure);
    const existingWorker = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 126,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn1, Spawn2: spawn2 },
      creeps: { ExistingWorker: existingWorker }
    };

    runEconomy();

    expect(spawn1.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn2.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn1.spawnCreep).toHaveBeenCalledWith(
      ['work', 'carry', 'move'],
      'worker-W1N1-126',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
    expect(spawn2.spawnCreep).toHaveBeenCalledWith(
      ['work', 'carry', 'move'],
      'worker-W1N1-126-2',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
  });

  it('uses a stable secondary-room spawn for primary worker recovery when the primary spawn is busy', () => {
    installSpawnCoordinationGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const primaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controllerLevel: 1
    });
    const secondaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W2N1',
      energyAvailable: 800,
      energyCapacityAvailable: 800
    });
    const primarySpawn = {
      name: 'Spawn1',
      room: primaryRoom,
      spawning: { name: 'busy-worker' } as Spawning,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondarySpawn = {
      name: 'Spawn2',
      room: secondaryRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondaryWorkers = {
      Worker1: makeEconomyWorker(secondaryRoom),
      Worker2: makeEconomyWorker(secondaryRoom),
      Worker3: makeEconomyWorker(secondaryRoom),
      Worker4: makeEconomyWorker(secondaryRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 131,
      rooms: { W1N1: primaryRoom, W2N1: secondaryRoom },
      spawns: { Spawn1: primarySpawn, Spawn2: secondarySpawn },
      creeps: secondaryWorkers
    };

    runEconomy();

    expect(primarySpawn.spawnCreep).not.toHaveBeenCalled();
    expect(secondarySpawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-131', {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        spawnSupport: { originRoom: 'W2N1', targetRoom: 'W1N1' }
      }
    });
  });

  it('keeps primary worker recovery ahead of secondary surplus production', () => {
    installSpawnCoordinationGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const primaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controllerLevel: 1
    });
    const secondaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W2N1',
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });
    const primarySpawn = {
      name: 'Spawn1',
      room: primaryRoom,
      spawning: { name: 'busy-worker' } as Spawning,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondarySpawn = {
      name: 'Spawn2',
      room: secondaryRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondaryWorkers = {
      Worker1: makeEconomyWorker(secondaryRoom),
      Worker2: makeEconomyWorker(secondaryRoom),
      Worker3: makeEconomyWorker(secondaryRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 132,
      rooms: { W1N1: primaryRoom, W2N1: secondaryRoom },
      spawns: { Spawn1: primarySpawn, Spawn2: secondarySpawn },
      creeps: secondaryWorkers
    };

    runEconomy();

    expect(primarySpawn.spawnCreep).not.toHaveBeenCalled();
    expect(secondarySpawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(secondarySpawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-132', {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        spawnSupport: { originRoom: 'W2N1', targetRoom: 'W1N1' }
      }
    });
  });

  it('keeps a secondary source room from bypassing its own spawn buffer for primary recovery', () => {
    installSpawnCoordinationGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const primaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controllerLevel: 1
    });
    const secondaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W2N1',
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controllerLevel: 4
    });
    const primarySpawn = {
      name: 'Spawn1',
      room: primaryRoom,
      spawning: { name: 'busy-worker' } as Spawning,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondarySpawn = {
      name: 'Spawn2',
      room: secondaryRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondaryWorkers = {
      Worker1: makeEconomyWorker(secondaryRoom),
      Worker2: makeEconomyWorker(secondaryRoom),
      Worker3: makeEconomyWorker(secondaryRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 135,
      rooms: { W1N1: primaryRoom, W2N1: secondaryRoom },
      spawns: { Spawn1: primarySpawn, Spawn2: secondarySpawn },
      creeps: secondaryWorkers
    };

    runEconomy();

    expect(primarySpawn.spawnCreep).not.toHaveBeenCalled();
    expect(secondarySpawn.spawnCreep).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      '[spawn] warning: deferred worker-W1N1-135 in W2N1; available energy 650, body cost 200, required buffer 500'
    );
  });

  it('keeps secondary bootstrap energy local instead of borrowing it for primary territory control', () => {
    installSpawnCoordinationGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: { targets: [{ colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }] }
    };
    const primaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W1N1',
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });
    const secondaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W2N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controllerLevel: 1
    });
    const reserveRoom = makeVisibleReserveRoom('W3N1', 'controller3' as Id<StructureController>);
    const primarySpawn = {
      name: 'Spawn1',
      room: primaryRoom,
      spawning: { name: 'busy-worker' } as Spawning,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondarySpawn = {
      name: 'Spawn2',
      room: secondaryRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const primaryWorkers = {
      Worker1: makeEconomyWorker(primaryRoom),
      Worker2: makeEconomyWorker(primaryRoom),
      Worker3: makeEconomyWorker(primaryRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 132,
      rooms: { W1N1: primaryRoom, W2N1: secondaryRoom, W3N1: reserveRoom },
      spawns: { Spawn1: primarySpawn, Spawn2: secondarySpawn },
      creeps: primaryWorkers,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(primarySpawn.spawnCreep).not.toHaveBeenCalled();
    expect(secondarySpawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W2N1-132', {
      memory: { role: 'worker', colony: 'W2N1' }
    });
  });

  it('keeps primary claimer production working while a secondary room bootstraps local workers', () => {
    installSpawnCoordinationGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: { targets: [{ colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }] }
    };
    const primaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W1N1',
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });
    const secondaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W2N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controllerLevel: 1
    });
    const reserveRoom = makeVisibleReserveRoom('W3N1', 'controller3' as Id<StructureController>);
    const primarySpawn = {
      name: 'Spawn1',
      room: primaryRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondarySpawn = {
      name: 'Spawn2',
      room: secondaryRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const primaryWorkers = {
      Worker1: makeEconomyWorker(primaryRoom),
      Worker2: makeEconomyWorker(primaryRoom),
      Worker3: makeEconomyWorker(primaryRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 133,
      rooms: { W1N1: primaryRoom, W2N1: secondaryRoom, W3N1: reserveRoom },
      spawns: { Spawn1: primarySpawn, Spawn2: secondarySpawn },
      creeps: primaryWorkers,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(primarySpawn.spawnCreep).toHaveBeenCalledWith(['claim', 'move'], 'claimer-W1N1-W3N1-133', {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W3N1', action: 'reserve', controllerId: 'controller3' }
      }
    });
    expect(secondarySpawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W2N1-133', {
      memory: { role: 'worker', colony: 'W2N1' }
    });
  });

  it('refreshes action-hint reserve targets before economy spawn planning', () => {
    installSpawnCoordinationGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W3N1',
            actionHint: 'reserve',
            controllerId: 'controller3' as Id<StructureController>
          } as unknown as TerritoryTargetMemory
        ]
      }
    };
    const primaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W1N1',
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });
    const reserveRoom = makeVisibleReserveRoom('W3N1', 'controller3' as Id<StructureController>);
    const spawn = {
      name: 'Spawn1',
      room: primaryRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const creeps = {
      Worker1: makeEconomyWorker(primaryRoom),
      Worker2: makeEconomyWorker(primaryRoom),
      Worker3: makeEconomyWorker(primaryRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 136,
      rooms: { W1N1: primaryRoom, W3N1: reserveRoom },
      spawns: { Spawn1: spawn },
      creeps,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['claim', 'move'], 'claimer-W1N1-W3N1-136', {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W3N1', action: 'reserve', controllerId: 'controller3' }
      }
    });
    expect(Memory.territory?.targets?.[0]).toMatchObject({
      colony: 'W1N1',
      roomName: 'W3N1',
      action: 'reserve',
      actionHint: 'reserve',
      controllerId: 'controller3'
    });
  });

  it('can use a stable secondary-room spawn for primary reserver production when the primary spawn is busy', () => {
    installSpawnCoordinationGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: { targets: [{ colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }] }
    };
    const primaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W1N1',
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });
    const secondaryRoom = makeSpawnCoordinationRoom({
      roomName: 'W2N1',
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });
    const reserveRoom = makeVisibleReserveRoom('W3N1', 'controller3' as Id<StructureController>);
    const primarySpawn = {
      name: 'Spawn1',
      room: primaryRoom,
      spawning: { name: 'busy-worker' } as Spawning,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const secondarySpawn = {
      name: 'Spawn2',
      room: secondaryRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const creeps = {
      PrimaryWorker1: makeEconomyWorker(primaryRoom),
      PrimaryWorker2: makeEconomyWorker(primaryRoom),
      PrimaryWorker3: makeEconomyWorker(primaryRoom),
      SecondaryWorker1: makeEconomyWorker(secondaryRoom),
      SecondaryWorker2: makeEconomyWorker(secondaryRoom),
      SecondaryWorker3: makeEconomyWorker(secondaryRoom),
      SecondaryWorker4: makeEconomyWorker(secondaryRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 134,
      rooms: { W1N1: primaryRoom, W2N1: secondaryRoom, W3N1: reserveRoom },
      spawns: { Spawn1: primarySpawn, Spawn2: secondarySpawn },
      creeps,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(primarySpawn.spawnCreep).not.toHaveBeenCalled();
    expect(secondarySpawn.spawnCreep).toHaveBeenCalledWith(['claim', 'move'], 'claimer-W1N1-W3N1-134', {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W3N1', action: 'reserve', controllerId: 'controller3' }
      }
    });
  });

  it('keeps a single source-room spawn on local recovery before cross-room hauling', () => {
    (globalThis as unknown as { FIND_SOURCES: number; RESOURCE_ENERGY: ResourceConstant }).FIND_SOURCES = 1;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const sourceRoom = makeStorageEconomyRoom({
      roomName: 'W1N1',
      storageEnergy: 950,
      energyAvailable: 300,
      energyCapacityAvailable: 300
    });
    const targetRoom = makeStorageEconomyRoom({
      roomName: 'W2N1',
      storageEnergy: 100,
      energyAvailable: 300,
      energyCapacityAvailable: 300
    });
    const spawn = {
      name: 'Spawn1',
      room: sourceRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 129,
      rooms: { W1N1: sourceRoom, W2N1: targetRoom },
      spawns: { Spawn1: spawn },
      creeps: {},
      map: {
        findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 1, room: toRoom }])
      } as unknown as GameMap
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-129', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('preserves source-room spawn buffer after local recovery before cross-room hauling', () => {
    (globalThis as unknown as { FIND_SOURCES: number; RESOURCE_ENERGY: ResourceConstant }).FIND_SOURCES = 1;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const sourceRoom = makeStorageEconomyRoom({
      roomName: 'W1N1',
      storageEnergy: 950,
      energyAvailable: 600,
      energyCapacityAvailable: 300
    });
    const targetRoom = makeStorageEconomyRoom({
      roomName: 'W2N1',
      storageEnergy: 100,
      energyAvailable: 300,
      energyCapacityAvailable: 300
    });
    const spawn1 = {
      name: 'Spawn1',
      room: sourceRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const spawn2 = {
      name: 'Spawn2',
      room: sourceRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(sourceRoom),
      Worker2: makeEconomyWorker(sourceRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 130,
      rooms: { W1N1: sourceRoom, W2N1: targetRoom },
      spawns: { Spawn1: spawn1, Spawn2: spawn2 },
      creeps: workers,
      map: {
        findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 1, room: toRoom }])
      } as unknown as GameMap
    };

    runEconomy();

    expect(spawn1.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn2.spawnCreep).not.toHaveBeenCalled();
    expect(spawn1.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-130', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(Memory.economy?.spawnEnergyBuffer?.rooms.W1N1).toMatchObject({
      currentEnergy: 400,
      healthy: false,
      spawnCount: 2,
      threshold: 800
    });
  });

  it('keeps spawning a productive worker while baseline workers still leave refill pressure', () => {
    (globalThis as unknown as {
      FIND_MY_STRUCTURES: number;
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_SOURCES: number;
      STRUCTURE_EXTENSION: StructureConstant;
    }).FIND_MY_STRUCTURES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 4;
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    const extensions = Array.from(
      { length: 5 },
      (_, index) => ({ id: `extension${index}`, structureType: 'extension' }) as StructureExtension
    );
    const room = {
      name: 'W1N1',
      energyAvailable: 400 + MIN_SPAWN_ENERGY_BUFFER,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 2, ticksToDowngrade: 10_000 } as StructureController,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureExtension) => boolean }) => {
        if (type === FIND_SOURCES) {
          return [{ id: 'source1' } as Source];
        }

        if (type === FIND_MY_STRUCTURES) {
          return options?.filter ? extensions.filter(options.filter) : extensions;
        }

        return [];
      })
    } as unknown as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 127,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: workers
    };

    runEconomy();

    expect(spawn.spawnCreep).not.toHaveBeenCalled();
    expect(Memory.economy?.spawnEnergyBuffer?.rooms.W1N1).toMatchObject({
      currentEnergy: 450,
      healthy: true,
      threshold: 300
    });
  });

  it('defers a refill worker when raw room energy would consume the spawn buffer', () => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 4;
    const room = {
      name: 'W1N1',
      energyAvailable: 400,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: 'source1' } as Source] : []))
    } as unknown as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 128,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: workers
    };

    runEconomy();

    expect(spawn.spawnCreep).not.toHaveBeenCalled();
    expect(Memory.economy?.spawnEnergyBuffer?.rooms.W1N1).toMatchObject({
      currentEnergy: 400,
      healthy: true,
      threshold: 400
    });
  });

  it('lets a local container miner use the spawn buffer after the worker floor is stable', () => {
    installSpawnCoordinationGlobals();
    Object.assign(globalThis, {
      BODYPART_COST: {
        move: 50,
        work: 100,
        carry: 50,
        attack: 80,
        ranged_attack: 150,
        heal: 250,
        claim: 600,
        tough: 10
      },
      FIND_STRUCTURES: 5,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_CONTAINER: 'container',
      Memory: {}
    });
    const source = {
      id: 'source0',
      energyCapacity: 3_000,
      pos: { x: 10, y: 10, roomName: 'W1N1' } as RoomPosition
    } as Source;
    const container = {
      id: 'container0',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'W1N1' } as RoomPosition
    } as StructureContainer;
    let spawn = {} as StructureSpawn;
    const room = {
      name: 'W1N1',
      energyAvailable: 600,
      energyCapacityAvailable: 600,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        if (type === FIND_STRUCTURES) {
          return [container];
        }

        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      room,
      structureType: 'spawn',
      pos: { x: 5, y: 5, roomName: 'W1N1' } as RoomPosition,
      spawning: null,
      store: { getUsedCapacity: jest.fn().mockReturnValue(300) },
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 129,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: workers
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
      'sourceHarvester-W1N1-source0-129',
      {
        memory: {
          role: 'sourceHarvester',
          colony: 'W1N1',
          sourceHarvester: {
            roomName: 'W1N1',
            sourceId: 'source0',
            containerId: 'container0'
          }
        }
      }
    );
    expect(Memory.economy?.spawnEnergyBuffer?.rooms.W1N1).toMatchObject({
      currentEnergy: 0,
      healthy: false,
      threshold: 400
    });
  });

  it('waits through critical energy without invalid spawn attempts and recovers when an emergency body is affordable', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 199,
      energyCapacityAvailable: 400,
      controller: { my: true } as StructureController
    } as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 126,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {}
    };

    runEconomy();
    Game.time = 127;
    runEconomy();

    expect(spawn.spawnCreep).not.toHaveBeenCalled();

    room.energyAvailable = 300;
    Game.time = 128;
    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-128', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('retries another idle spawn when the planned spawn reports busy and emits both outcomes', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller: { my: true } as StructureController
    } as Room;
    const busySpawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(-4)
    } as unknown as StructureSpawn;
    const retrySpawn = {
      name: 'Spawn2',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 124,
      rooms: {
        W1N1: room
      },
      spawns: { Spawn1: busySpawn, Spawn2: retrySpawn },
      creeps: {}
    };

    runEconomy();

    const spawnArgs: Parameters<StructureSpawn['spawnCreep']> = [
      ['work', 'carry', 'move'],
      'worker-W1N1-124',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    ];
    expect(busySpawn.spawnCreep).toHaveBeenCalledWith(...spawnArgs);
    expect(retrySpawn.spawnCreep).toHaveBeenCalledWith(...spawnArgs);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(typeof message).toBe('string');
    expect((message as string).startsWith(RUNTIME_SUMMARY_PREFIX)).toBe(true);
    expect(JSON.parse((message as string).slice(RUNTIME_SUMMARY_PREFIX.length))).toMatchObject({
      events: [
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn1',
          creepName: 'worker-W1N1-124',
          role: 'worker',
          result: -4
        },
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn2',
          creepName: 'worker-W1N1-124',
          role: 'worker',
          result: 0
        }
      ]
    });
  });

  it('does not attempt duplicate spawning while a successful spawn stays busy across ticks', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller: { my: true } as StructureController
    } as Room;
    const creeps: Record<string, Creep> = {};
    const spawn = createLifecycleSpawn(room, creeps, 3);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawning).toMatchObject({ name: 'worker-W1N1-200', remainingTime: 3 });

    Game.time = 201;
    spawn.advanceSpawnLifecycle();
    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawning).toMatchObject({ name: 'worker-W1N1-200', remainingTime: 2 });

    Game.time = 202;
    spawn.advanceSpawnLifecycle();
    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawning).toMatchObject({ name: 'worker-W1N1-200', remainingTime: 1 });

    spawn.advanceSpawnLifecycle();

    expect(spawn.spawning).toBeNull();
    expect(creeps['worker-W1N1-200']?.memory).toEqual({ role: 'worker', colony: 'W1N1' });
  });

  it('plans extension construction before workers select build targets', () => {
    (globalThis as unknown as {
      FIND_MY_STRUCTURES: number;
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_CONSTRUCTION_SITES: number;
      RESOURCE_ENERGY: ResourceConstant;
      STRUCTURE_EXTENSION: StructureConstant;
      TERRAIN_MASK_WALL: number;
      LOOK_STRUCTURES: LOOK_STRUCTURES;
      LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES;
    }).FIND_MY_STRUCTURES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 3;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { LOOK_STRUCTURES: LOOK_STRUCTURES }).LOOK_STRUCTURES = 'structure';
    (globalThis as unknown as { LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES }).LOOK_CONSTRUCTION_SITES = 'constructionSite';

    const constructionSites: ConstructionSite[] = [];
    const room = {
      name: 'W1N1',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller: { my: true, level: 2, id: 'controller1' } as StructureController,
      find: jest.fn((type: number) => (type === 3 ? constructionSites : [])),
      lookForAt: jest.fn(() => {
        throw new Error('extension planner should use cached occupancy instead of per-candidate lookups');
      }),
      lookForAtArea: jest.fn().mockReturnValue([]),
      createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
        constructionSites.push({ id: `site-${x}-${y}`, structureType, pos: { x, y, roomName: 'W1N1' } as RoomPosition } as ConstructionSite);
        return OK_CODE;
      })
    } as unknown as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      pos: { x: 25, y: 25, roomName: 'W1N1' },
      spawning: null,
      spawnCreep: jest.fn()
    } as unknown as StructureSpawn;
    const worker = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 250,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {
        Worker1: worker,
        Worker2: makeEconomyWorker(room),
        Worker3: makeEconomyWorker(room),
        Worker4: makeEconomyWorker(room),
        Worker5: makeEconomyWorker(room)
      },
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as Game['map']
    };

    runEconomy();

    expect(room.createConstructionSite).toHaveBeenCalledWith(24, 24, STRUCTURE_EXTENSION);
    expect(worker.memory.task).toEqual({ type: 'build', targetId: 'site-24-24' });
  });

  it('preempts an existing RCL2 upgrade task for newly planned extension construction', () => {
    (globalThis as unknown as {
      FIND_MY_STRUCTURES: number;
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_CONSTRUCTION_SITES: number;
      RESOURCE_ENERGY: ResourceConstant;
      STRUCTURE_EXTENSION: StructureConstant;
      TERRAIN_MASK_WALL: number;
      LOOK_STRUCTURES: LOOK_STRUCTURES;
      LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES;
    }).FIND_MY_STRUCTURES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 3;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { LOOK_STRUCTURES: LOOK_STRUCTURES }).LOOK_STRUCTURES = 'structure';
    (globalThis as unknown as { LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES }).LOOK_CONSTRUCTION_SITES = 'constructionSite';

    const constructionSites: ConstructionSite[] = [];
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller,
      find: jest.fn((type: number) => (type === 3 ? constructionSites : [])),
      lookForAt: jest.fn(() => {
        throw new Error('extension planner should use cached occupancy instead of per-candidate lookups');
      }),
      lookForAtArea: jest.fn().mockReturnValue([]),
      createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
        constructionSites.push({ id: `site-${x}-${y}`, structureType, pos: { x, y, roomName: 'W1N1' } as RoomPosition } as ConstructionSite);
        return OK_CODE;
      })
    } as unknown as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      pos: { x: 25, y: 25, roomName: 'W1N1' },
      spawning: null,
      spawnCreep: jest.fn()
    } as unknown as StructureSpawn;
    const worker = {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 251,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {
        Worker1: worker,
        Worker2: makeEconomyWorker(room),
        Worker3: makeEconomyWorker(room),
        Worker4: makeEconomyWorker(room),
        Worker5: makeEconomyWorker(room)
      },
      getObjectById: jest.fn().mockReturnValue(controller),
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as Game['map']
    };

    runEconomy();

    expect(room.createConstructionSite).toHaveBeenCalledWith(24, 24, STRUCTURE_EXTENSION);
    expect(worker.memory.task).toEqual({ type: 'build', targetId: 'site-24-24' });
    expect(worker.upgradeController).not.toHaveBeenCalled();
    expect(worker.moveTo).not.toHaveBeenCalled();
  });

  it('plans missing source containers before tower construction for an owned expansion room', () => {
    (globalThis as unknown as {
      FIND_MY_STRUCTURES: number;
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_STRUCTURES: number;
      FIND_CONSTRUCTION_SITES: number;
      FIND_SOURCES: number;
      RESOURCE_ENERGY: ResourceConstant;
      STRUCTURE_EXTENSION: StructureConstant;
      STRUCTURE_TOWER: StructureConstant;
      STRUCTURE_CONTAINER: StructureConstant;
      LOOK_STRUCTURES: LOOK_STRUCTURES;
      LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES;
      TERRAIN_MASK_WALL: number;
      Memory: Partial<Memory>;
    }).FIND_MY_STRUCTURES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 3;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 4;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 5;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { LOOK_STRUCTURES: LOOK_STRUCTURES }).LOOK_STRUCTURES = 'structure';
    (globalThis as unknown as { LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES }).LOOK_CONSTRUCTION_SITES =
      'constructionSite';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};

    const constructionSites: ConstructionSite[] = [];
    let ownedStructures: AnyOwnedStructure[] = [];
    const room = {
      name: 'W2N1',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller: {
        my: true,
        owner: { username: 'me' },
        level: 3,
        ticksToDowngrade: 10_000,
        pos: { x: 25, y: 25, roomName: 'W2N1' }
      } as StructureController,
      find: jest.fn((type: number, options?: { filter?: (target: unknown) => boolean }) => {
        const targets =
          type === FIND_MY_STRUCTURES
            ? ownedStructures
            : type === FIND_MY_CONSTRUCTION_SITES || type === FIND_CONSTRUCTION_SITES
              ? constructionSites
              : type === FIND_STRUCTURES
                ? ownedStructures
                : type === FIND_SOURCES
                  ? ([{ id: 'source1', pos: { x: 10, y: 10, roomName: 'W2N1' } as RoomPosition }] as Source[])
                  : [];

        return options?.filter ? targets.filter(options.filter) : targets;
      }),
      lookForAtArea: jest.fn().mockReturnValue([]),
      createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
        constructionSites.push({
          id: `site-${x}-${y}`,
          structureType,
          pos: { x, y, roomName: 'W2N1' } as RoomPosition
        } as ConstructionSite);
        return OK_CODE;
      })
    } as unknown as Room;
    const spawn = {
      name: 'Spawn2',
      room,
      pos: { x: 25, y: 25, roomName: 'W2N1' },
      structureType: 'spawn',
      spawning: null,
      spawnCreep: jest.fn()
    } as unknown as StructureSpawn;
    ownedStructures = [
      spawn as unknown as AnyOwnedStructure,
      ...Array.from(
        { length: 10 },
        (_, index) =>
          ({
            id: `extension-${index}`,
            structureType: 'extension',
            pos: { x: 35 + index, y: 35, roomName: 'W2N1' } as RoomPosition
          }) as AnyOwnedStructure
      )
    ];
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 252,
      rooms: { W2N1: room },
      spawns: { Spawn2: spawn },
      creeps: workers,
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as GameMap
    };

    runEconomy();

    expect(room.createConstructionSite).toHaveBeenCalledTimes(2);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 11, 11, STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 24, 24, STRUCTURE_TOWER);
  });

  it('runs existing worker creeps', () => {
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([{ id: 'source1' } as Source]) }
    } as unknown as Creep;
    (globalThis as unknown as { FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; RESOURCE_ENERGY: ResourceConstant }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 123,
      rooms: {},
      spawns: {},
      creeps: { Worker1: creep }
    };

    runEconomy();

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('runs existing territory controller creeps', () => {
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      reserveController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 300,
      rooms: {},
      spawns: {},
      creeps: { Reserver1: creep }
    };

    runEconomy();

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
  });

  it('turns a safe occupation recommendation into same-tick expansion claim pressure', () => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300
    });
    const targetRoom = makeVisibleReserveRoom('W2N1', 'controller2' as Id<StructureController>);
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 320,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' }))
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 320);

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      ['claim', 'move'],
      'claimer-W1N1-W2N1-320',
      {
        memory: {
          role: 'claimer',
          colony: 'W1N1',
          territory: {
            targetRoom: 'W2N1',
            action: 'claim',
            controllerId: 'controller2'
          }
        }
      }
    );
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'autonomousExpansionClaim',
        controllerId: 'controller2'
      }
    ]);
  });

  it('spawns a next-expansion claimer from sufficient scout-intel scoring', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_HOSTILE_CREEPS: number;
      FIND_HOSTILE_STRUCTURES: number;
      TERRAIN_MASK_WALL: number;
      TERRAIN_MASK_SWAMP: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            updatedAt: 500,
            controller: { id: 'controller2' as Id<StructureController>, my: false },
            sourceIds: ['source-a', 'source-b'],
            sourceCount: 2,
            sourceAccessPoints: 7,
            controllerSourceRange: 8,
            terrain: { walkableRatio: 0.92, swampRatio: 0.04, wallRatio: 0.08 },
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300
    });
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 505,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain))
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 505);

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      ['claim', 'claim', 'move', 'move'],
      'claimer-W1N1-W2N1-505',
      {
        memory: {
          role: 'claimer',
          colony: 'W1N1',
          territory: {
            targetRoom: 'W2N1',
            action: 'reserve',
            controllerId: 'controller2'
          }
        }
      }
    );
    expect(room.memory.cachedExpansionSelection).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller2'
      }
    ]);
  });

  it('reuses cached next expansion scoring between refresh ticks', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_HOSTILE_CREEPS: number;
      FIND_HOSTILE_STRUCTURES: number;
      TERRAIN_MASK_WALL: number;
      TERRAIN_MASK_SWAMP: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300
    });
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    const getRoomTerrain = jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 501,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 501);

    runEconomy();

    expect(getRoomTerrain).toHaveBeenCalledTimes(2);
    expect(room.memory.lastExpansionScoreTime).toBe(501);
    expect(room.memory.cachedExpansionSelection).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller2'
      }
    ]);

    getRoomTerrain.mockImplementation(() => {
      throw new Error('next expansion scoring should reuse the cached selection between refresh ticks');
    });
    (spawn as StructureSpawn & { spawning: Spawning | null }).spawning = {
      name: 'claimer-W1N1-W2N1-501',
      remainingTime: 1
    } as Spawning;
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 502;

    runEconomy();

    expect(getRoomTerrain).toHaveBeenCalledTimes(2);
    expect(room.memory.lastExpansionScoreTime).toBe(502);
  });

  it('refreshes next expansion scoring before the interval when colony state changes', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_HOSTILE_CREEPS: number;
      FIND_HOSTILE_STRUCTURES: number;
      TERRAIN_MASK_WALL: number;
      TERRAIN_MASK_SWAMP: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300
    });
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    const getRoomTerrain = jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 501,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 501);

    runEconomy();

    room.energyCapacityAvailable = 1_400;
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 502;

    runEconomy();

    expect(getRoomTerrain).toHaveBeenCalledTimes(3);
    expect(room.memory.lastExpansionScoreTime).toBe(502);
    expect(room.memory.cachedExpansionSelection).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1'
    });
  });

  it('refreshes next expansion scoring before the interval when owned room count reaches the RCL cap', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_HOSTILE_CREEPS: number;
      FIND_HOSTILE_STRUCTURES: number;
      TERRAIN_MASK_WALL: number;
      TERRAIN_MASK_SWAMP: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300
    });
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    const getRoomTerrain = jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 501,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 501);

    runEconomy();

    (globalThis as unknown as { Game: Partial<Game> }).Game.rooms = {
      W1N1: room,
      W2N1: targetRoom,
      W3N1: makeOwnedEconomyRoom('W3N1')
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 502;

    runEconomy();

    expect(getRoomTerrain).toHaveBeenCalledTimes(4);
    expect(room.memory.lastExpansionScoreTime).toBe(502);
    expect(room.memory.cachedExpansionSelection).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'roomLimitReached'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 502,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2'
      }
    ]);
  });

  it('keeps next expansion claims reserved while GCL capacity is full', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_HOSTILE_CREEPS: number;
      FIND_HOSTILE_STRUCTURES: number;
      TERRAIN_MASK_WALL: number;
      TERRAIN_MASK_SWAMP: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const room = makeTerritoryReadyEconomyRoom();
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 506,
      gcl: { level: 1 } as GlobalControlLevel,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: {},
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain))
      } as unknown as GameMap
    };

    runEconomy();

    expect(room.memory.cachedExpansionSelection).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'gclInsufficient'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 506,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2'
      }
    ]);
  });

  it('refreshes recommendation reserve targets when the RCL room limit caps expansion claims', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_HOSTILE_CREEPS: number;
      FIND_HOSTILE_STRUCTURES: number;
      TERRAIN_MASK_WALL: number;
      TERRAIN_MASK_SWAMP: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    const recommendationTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W9N9',
      action: 'reserve',
      createdBy: 'occupationRecommendation'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: { targets: [recommendationTarget] }
    };
    const room = makeTerritoryReadyEconomyRoom();
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 503,
      rooms: { W1N1: room, W2N1: targetRoom, W3N1: makeOwnedEconomyRoom('W3N1') },
      spawns: {},
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain))
      } as unknown as GameMap
    };

    runEconomy();

    expect(room.memory.cachedExpansionSelection).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'roomLimitReached'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2'
      }
    ]);
    expect(Memory.territory?.targets).not.toContainEqual(recommendationTarget);
  });

  it('clears stale automated claim recommendations while preserving RCL-capped reserves', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_HOSTILE_CREEPS: number;
      FIND_HOSTILE_STRUCTURES: number;
      TERRAIN_MASK_WALL: number;
      TERRAIN_MASK_SWAMP: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'claim',
            createdBy: 'autonomousExpansionClaim',
            controllerId: 'controller2' as Id<StructureController>
          },
          {
            colony: 'W1N1',
            roomName: 'W4N1',
            action: 'claim',
            createdBy: 'occupationRecommendation',
            controllerId: 'controller4' as Id<StructureController>
          }
        ],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 499,
            createdBy: 'autonomousExpansionClaim',
            controllerId: 'controller2' as Id<StructureController>
          },
          {
            colony: 'W1N1',
            targetRoom: 'W4N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 499,
            controllerId: 'controller4' as Id<StructureController>
          }
        ]
      }
    };
    const room = makeTerritoryReadyEconomyRoom();
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 504,
      rooms: { W1N1: room, W2N1: targetRoom, W3N1: makeOwnedEconomyRoom('W3N1') },
      spawns: {},
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain))
      } as unknown as GameMap
    };

    runEconomy();

    expect(room.memory.cachedExpansionSelection).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'roomLimitReached'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 504,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2'
      }
    ]);
  });

  it('uses a second idle spawn for controller pressure after spawning follow-up support', () => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 323,
            requiresControllerPressure: true,
            followUp
          }
        ]
      }
    };
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 4_050,
      energyCapacityAvailable: 4_050
    });
    const targetRoom = makeVisibleForeignReservedRoom('W2N1', 'controller2' as Id<StructureController>);
    const spawn1 = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const spawn2 = {
      name: 'Spawn2',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 323,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn1, Spawn2: spawn2 },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(spawn1.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn2.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn1.spawnCreep).toHaveBeenCalledWith(
      SCALED_WORKER_800,
      'worker-W1N1-323',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
    expect(spawn2.spawnCreep).toHaveBeenCalledWith(
      ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move'],
      'claimer-W1N1-W2N1-323-2',
      {
        memory: {
          role: 'claimer',
          colony: 'W1N1',
          territory: {
            targetRoom: 'W2N1',
            action: 'reserve',
            controllerId: 'controller2',
            followUp
          }
        }
      }
    );
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 323,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller2',
        requiresControllerPressure: true,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 323,
        followUp
      }
    ]);
  });

  it('reserves energy for queued territory control after a support worker spawn', () => {
    installSpawnCoordinationGlobals();
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    Object.assign(globalThis, {
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_SPAWN: 'spawn'
    });
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 326,
            requiresControllerPressure: true,
            followUp
          }
        ]
      }
    };
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 4_050,
      energyCapacityAvailable: 4_050
    });
    const targetRoom = makeVisibleReserveRoom('W2N1', 'controller2' as Id<StructureController>);
    let spawn = {} as StructureSpawn;
    room.find = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_SOURCES) {
          return [{ id: 'home-source' } as Source];
        }

        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      }
    ) as Room['find'];
    spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      room,
      structureType: 'spawn',
      spawning: null,
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) },
      spawnCreep: jest.fn((_body: BodyPartConstant[]) => {
        (room as Room & { energyAvailable: number }).energyAvailable = 3_000;
        return OK_CODE;
      })
    } as unknown as StructureSpawn;
    const loadedWorker = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'W1N1' },
      room,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as Creep;
    const workers = {
      Worker1: loadedWorker,
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 326,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      SCALED_WORKER_800,
      'worker-W1N1-326',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
    expect(Memory.economy?.spawnEnergyReservation?.rooms.W1N1).toMatchObject({
      reservedEnergy: 3_250,
      role: 'claimer',
      creepName: 'claimer-W1N1-W2N1-326-2',
      sourceCreepName: 'worker-W1N1-326',
      sourceRole: 'worker'
    });
    expect(Memory.economy?.spawnEnergyBuffer?.rooms.W1N1).toMatchObject({
      currentEnergy: 3_500,
      reservedEnergy: 3_250,
      unmetReservedEnergy: 250
    });
    expect(loadedWorker.memory.task).toBeUndefined();
  });

  it('releases reserved spawn energy after the spawn stays idle past the grace window', () => {
    installSpawnCoordinationGlobals();
    const reservedAt = 400;
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: reservedAt,
          rooms: {
            W1N1: {
              bodyCost: 650,
              creepName: 'claimer-W1N1-W2N1-400',
              idleSince: reservedAt,
              idleTicks: 0,
              reservedAt,
              reservedEnergy: 650,
              role: 'claimer',
              roomName: 'W1N1',
              updatedAt: reservedAt
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: reservedAt + SPAWN_ENERGY_RESERVATION_IDLE_RELEASE_TICKS + 1,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {
        Worker1: makeEconomyWorker(room),
        Worker2: makeEconomyWorker(room),
        Worker3: makeEconomyWorker(room)
      }
    };

    runEconomy();

    expect(Memory.economy?.spawnEnergyReservation?.rooms.W1N1).toBeUndefined();
  });

  it('keeps reserved spawn energy while any spawn in the room is still busy', () => {
    installSpawnCoordinationGlobals();
    const reservedAt = 410;
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });
    const idleSpawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const busySpawn = {
      name: 'Spawn2',
      room,
      spawning: { name: 'worker-W1N1-410', remainingTime: 3 } as Spawning,
      spawnCreep: jest.fn().mockReturnValue(ERR_BUSY_CODE)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: reservedAt,
          rooms: {
            W1N1: {
              bodyCost: 650,
              creepName: 'claimer-W1N1-W2N1-410',
              idleSince: reservedAt,
              idleTicks: 0,
              reservedAt,
              reservedEnergy: 650,
              role: 'claimer',
              roomName: 'W1N1',
              updatedAt: reservedAt
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: reservedAt + SPAWN_ENERGY_RESERVATION_IDLE_RELEASE_TICKS + 1,
      rooms: { W1N1: room },
      spawns: { Spawn1: idleSpawn, Spawn2: busySpawn },
      creeps: {
        Worker1: makeEconomyWorker(room),
        Worker2: makeEconomyWorker(room),
        Worker3: makeEconomyWorker(room)
      }
    };

    runEconomy();

    expect(Memory.economy?.spawnEnergyReservation?.rooms.W1N1).toMatchObject({
      bodyCost: 650,
      creepName: 'claimer-W1N1-W2N1-410',
      reservedEnergy: 650,
      role: 'claimer',
      roomName: 'W1N1',
      updatedAt: reservedAt + SPAWN_ENERGY_RESERVATION_IDLE_RELEASE_TICKS + 1
    });
    expect(Memory.economy?.spawnEnergyReservation?.rooms.W1N1?.idleSince).toBeUndefined();
    expect(Memory.economy?.spawnEnergyReservation?.rooms.W1N1?.idleTicks).toBeUndefined();
  });

  it('uses a second idle spawn for a non-pressure follow-up after spawning support', () => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 324,
            followUp
          }
        ]
      }
    };
    const room = makeTerritoryReadyEconomyRoom({
      energyAvailable: 1_450,
      energyCapacityAvailable: 1_450
    });
    const targetRoom = makeVisibleReserveRoom('W2N1', 'controller2' as Id<StructureController>);
    const spawn1 = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const spawn2 = {
      name: 'Spawn2',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 324,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn1, Spawn2: spawn2 },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(spawn1.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn2.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn1.spawnCreep).toHaveBeenCalledWith(
      SCALED_WORKER_800,
      'worker-W1N1-324',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
    expect(spawn2.spawnCreep).toHaveBeenCalledWith(['claim', 'move'], 'claimer-W1N1-W2N1-324-2', {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'reserve',
          controllerId: 'controller2',
          followUp
        }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 324,
        controllerId: 'controller2',
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 324,
        followUp
      }
    ]);
  });

  it('keeps normal territory planning available when a pending follow-up is allowed on the first pass', () => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W3N1', action: 'claim' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 324,
            followUp
          }
        ]
      }
    };
    const room = makeTerritoryReadyEconomyRoom();
    const followUpRoom = makeVisibleReserveRoom('W2N1', 'controller2' as Id<StructureController>);
    const configuredClaimRoom = makeVisibleReserveRoom('W3N1', 'controller3' as Id<StructureController>);
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room),
      Worker4: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 325,
      rooms: { W1N1: room, W2N1: followUpRoom, W3N1: configuredClaimRoom },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawnCreep).toHaveBeenCalledWith(['claim', 'move'], 'claimer-W1N1-W3N1-325', {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W3N1',
          action: 'claim',
          controllerId: 'controller3'
        }
      }
    });
    expect(Memory.territory?.intents).toContainEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 324,
      followUp
    });
    expect(Memory.territory?.intents).toContainEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 325,
      createdBy: 'occupationRecommendation',
      controllerId: 'controller3'
    });
  });

  it('plans an initial spawn construction site for a post-claim room without a spawn', () => {
    (globalThis as unknown as {
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_SOURCES: number;
      LOOK_STRUCTURES: LOOK_STRUCTURES;
      LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES;
      STRUCTURE_SPAWN: StructureConstant;
      TERRAIN_MASK_WALL: number;
      Memory: Partial<Memory>;
    }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { LOOK_STRUCTURES: LOOK_STRUCTURES }).LOOK_STRUCTURES = 'structure';
    (globalThis as unknown as { LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES }).LOOK_CONSTRUCTION_SITES = 'constructionSite';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'detected',
            claimedAt: 400,
            updatedAt: 400,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };
    const constructionSites: ConstructionSite[] = [];
    const room = {
      name: 'W2N1',
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller: {
        id: 'controller2',
        my: true,
        level: 1,
        pos: { x: 25, y: 25, roomName: 'W2N1' }
      } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [{ id: 'source1', pos: { x: 21, y: 21, roomName: 'W2N1' } } as Source];
        }

        if (type === FIND_MY_CONSTRUCTION_SITES) {
          return constructionSites;
        }

        return [];
      }),
      lookForAtArea: jest.fn().mockReturnValue([]),
      createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
        constructionSites.push({
          id: `site-${x}-${y}`,
          structureType,
          pos: { x, y, roomName: 'W2N1' }
        } as ConstructionSite);
        return OK_CODE;
      })
    } as unknown as Room;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 401,
      rooms: { W2N1: room },
      spawns: {},
      creeps: {},
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as GameMap
    };

    runEconomy();

    expect(room.createConstructionSite).toHaveBeenCalledWith(23, 23, STRUCTURE_SPAWN);
    expect(Memory.territory?.postClaimBootstraps?.W2N1).toMatchObject({
      status: 'spawnSitePending',
      updatedAt: 401,
      spawnSite: { roomName: 'W2N1', x: 23, y: 23 },
      lastResult: OK_CODE
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    const payload = JSON.parse((message as string).slice(RUNTIME_SUMMARY_PREFIX.length));
    expect(payload.events).toEqual(
      expect.arrayContaining([
        {
          type: 'postClaimBootstrap',
          roomName: 'W2N1',
          colony: 'W1N1',
          phase: 'spawnSite',
          controllerId: 'controller2',
          result: OK_CODE,
          spawnSite: { roomName: 'W2N1', x: 23, y: 23 },
          workerCount: 0,
          workerTarget: 2,
          spawnCount: 0
        },
        {
          type: 'spawnSitePlaced',
          roomName: 'W2N1',
          colony: 'W1N1',
          controllerId: 'controller2',
          result: OK_CODE,
          spawnSite: { roomName: 'W2N1', x: 23, y: 23 }
        }
      ])
    );
    expect(payload).toMatchObject({
      rooms: [
        {
          roomName: 'W2N1',
          postClaimBootstrap: {
            colony: 'W1N1',
            status: 'spawnSitePending',
            spawnSite: { roomName: 'W2N1', x: 23, y: 23 },
            lastResult: OK_CODE
          }
        }
      ]
    });
  });

  it('keeps post-claim spawn construction focused on one active room per tick', () => {
    (globalThis as unknown as {
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_SOURCES: number;
      LOOK_STRUCTURES: LOOK_STRUCTURES;
      LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES;
      STRUCTURE_SPAWN: StructureConstant;
      TERRAIN_MASK_WALL: number;
      Memory: Partial<Memory>;
    }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { LOOK_STRUCTURES: LOOK_STRUCTURES }).LOOK_STRUCTURES = 'structure';
    (globalThis as unknown as { LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES }).LOOK_CONSTRUCTION_SITES = 'constructionSite';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'detected',
            claimedAt: 400,
            updatedAt: 400,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          },
          W3N1: {
            colony: 'W1N1',
            roomName: 'W3N1',
            status: 'detected',
            claimedAt: 401,
            updatedAt: 401,
            workerTarget: 2,
            controllerId: 'controller3' as Id<StructureController>
          }
        }
      }
    };

    const makePostClaimRoom = (roomName: string, controllerId: Id<StructureController>): Room => {
      const constructionSites: ConstructionSite[] = [];
      return {
        name: roomName,
        energyAvailable: 0,
        energyCapacityAvailable: 0,
        controller: {
          id: controllerId,
          my: true,
          level: 1,
          pos: { x: 25, y: 25, roomName }
        } as StructureController,
        find: jest.fn((type: number) => {
          if (type === FIND_SOURCES) {
            return [{ id: `${roomName}-source1`, pos: { x: 21, y: 21, roomName } } as Source];
          }

          if (type === FIND_MY_CONSTRUCTION_SITES) {
            return constructionSites;
          }

          return [];
        }),
        lookForAtArea: jest.fn().mockReturnValue([]),
        createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
          constructionSites.push({
            id: `${roomName}-site-${x}-${y}`,
            structureType,
            pos: { x, y, roomName }
          } as ConstructionSite);
          return OK_CODE;
        })
      } as unknown as Room;
    };
    const olderRoom = makePostClaimRoom('W2N1', 'controller2' as Id<StructureController>);
    const newerRoom = makePostClaimRoom('W3N1', 'controller3' as Id<StructureController>);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 402,
      rooms: { W3N1: newerRoom, W2N1: olderRoom },
      spawns: {},
      creeps: {},
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as GameMap
    };

    runEconomy();

    expect(olderRoom.createConstructionSite).toHaveBeenCalledWith(23, 23, STRUCTURE_SPAWN);
    expect(newerRoom.createConstructionSite).not.toHaveBeenCalled();
    expect(Memory.territory?.postClaimBootstraps?.W2N1).toMatchObject({
      status: 'spawnSitePending',
      updatedAt: 402
    });
    expect(Memory.territory?.postClaimBootstraps?.W3N1).toMatchObject({
      status: 'detected',
      updatedAt: 401
    });
  });

  it('emits spawn-site telemetry when a claimed room already has an active spawn site', () => {
    (globalThis as unknown as {
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_SOURCES: number;
      STRUCTURE_SPAWN: StructureConstant;
      Memory: Partial<Memory>;
    }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'detected',
            claimedAt: 406,
            updatedAt: 406,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };
    const spawnSite = {
      id: 'spawn-site-existing',
      structureType: 'spawn',
      progress: 100,
      progressTotal: 15_000,
      pos: { x: 24, y: 24, roomName: 'W2N1' }
    } as ConstructionSite;
    const room = {
      name: 'W2N1',
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller: { id: 'controller2', my: true, level: 1 } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_MY_CONSTRUCTION_SITES) {
          return [spawnSite];
        }

        if (type === FIND_SOURCES) {
          return [{ id: 'source1' } as Source];
        }

        return [];
      }),
      createConstructionSite: jest.fn()
    } as unknown as Room;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 407,
      rooms: { W2N1: room },
      spawns: {},
      creeps: {}
    };

    runEconomy();

    expect(room.createConstructionSite).not.toHaveBeenCalled();
    const [message] = logSpy.mock.calls[0];
    const payload = JSON.parse((message as string).slice(RUNTIME_SUMMARY_PREFIX.length));
    expect(payload.events).toEqual(
      expect.arrayContaining([
        {
          type: 'spawnSitePlaced',
          roomName: 'W2N1',
          colony: 'W1N1',
          controllerId: 'controller2',
          result: OK_CODE,
          spawnSite: { roomName: 'W2N1', x: 24, y: 24 },
          existing: true
        }
      ])
    );
  });

  it('plans an initial spawn construction site beyond radius 6 when nearer tiles are blocked', () => {
    (globalThis as unknown as {
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_SOURCES: number;
      LOOK_STRUCTURES: LOOK_STRUCTURES;
      LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES;
      STRUCTURE_SPAWN: StructureConstant;
      TERRAIN_MASK_WALL: number;
      Memory: Partial<Memory>;
    }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { LOOK_STRUCTURES: LOOK_STRUCTURES }).LOOK_STRUCTURES = 'structure';
    (globalThis as unknown as { LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES }).LOOK_CONSTRUCTION_SITES =
      'constructionSite';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'detected',
            claimedAt: 402,
            updatedAt: 402,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };
    const constructionSites: ConstructionSite[] = [];
    const room = {
      name: 'W2N1',
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller: {
        id: 'controller2',
        my: true,
        level: 1,
        pos: { x: 25, y: 25, roomName: 'W2N1' }
      } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [{ id: 'source1', pos: { x: 21, y: 21, roomName: 'W2N1' } } as Source];
        }

        if (type === FIND_MY_CONSTRUCTION_SITES) {
          return constructionSites;
        }

        return [];
      }),
      lookForAtArea: jest.fn().mockReturnValue([]),
      createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
        constructionSites.push({
          id: `site-${x}-${y}`,
          structureType,
          pos: { x, y, roomName: 'W2N1' }
        } as ConstructionSite);
        return OK_CODE;
      })
    } as unknown as Room;
    const terrain = {
      get: jest.fn((x: number, y: number) => (Math.max(Math.abs(x - 23), Math.abs(y - 23)) <= 6 ? 1 : 0))
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 403,
      rooms: { W2N1: room },
      spawns: {},
      creeps: {},
      map: {
        getRoomTerrain: jest.fn().mockReturnValue(terrain)
      } as unknown as GameMap
    };

    runEconomy();

    expect(room.lookForAtArea).toHaveBeenCalledWith(LOOK_STRUCTURES, 15, 15, 31, 31, true);
    expect(room.lookForAtArea).toHaveBeenCalledWith(LOOK_CONSTRUCTION_SITES, 15, 15, 31, 31, true);
    expect(room.createConstructionSite).toHaveBeenCalledWith(16, 16, STRUCTURE_SPAWN);
    expect(Memory.territory?.postClaimBootstraps?.W2N1).toMatchObject({
      status: 'spawnSitePending',
      updatedAt: 403,
      spawnSite: { roomName: 'W2N1', x: 16, y: 16 },
      lastResult: OK_CODE
    });
  });

  it('skips mineral spawn tiles and retries when initial spawn site creation fails', () => {
    (globalThis as unknown as {
      FIND_MY_CONSTRUCTION_SITES: number;
      FIND_SOURCES: number;
      LOOK_STRUCTURES: LOOK_STRUCTURES;
      LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES;
      LOOK_MINERALS: LOOK_MINERALS;
      STRUCTURE_SPAWN: StructureConstant;
      TERRAIN_MASK_WALL: number;
      Memory: Partial<Memory>;
    }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { LOOK_STRUCTURES: LOOK_STRUCTURES }).LOOK_STRUCTURES = 'structure';
    (globalThis as unknown as { LOOK_CONSTRUCTION_SITES: LOOK_CONSTRUCTION_SITES }).LOOK_CONSTRUCTION_SITES =
      'constructionSite';
    (globalThis as unknown as { LOOK_MINERALS: LOOK_MINERALS }).LOOK_MINERALS = 'mineral';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'detected',
            claimedAt: 404,
            updatedAt: 404,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };
    const constructionSites: ConstructionSite[] = [];
    const room = {
      name: 'W2N1',
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller: {
        id: 'controller2',
        my: true,
        level: 1,
        pos: { x: 25, y: 25, roomName: 'W2N1' }
      } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [{ id: 'source1', pos: { x: 21, y: 21, roomName: 'W2N1' } } as Source];
        }

        if (type === FIND_MY_CONSTRUCTION_SITES) {
          return constructionSites;
        }

        return [];
      }),
      lookForAtArea: jest.fn((lookType: LookConstant) =>
        lookType === LOOK_MINERALS
          ? [{ x: 23, y: 23, mineral: { id: 'mineral1', pos: { x: 23, y: 23, roomName: 'W2N1' } } as Mineral }]
          : []
      ),
      createConstructionSite: jest
        .fn()
        .mockReturnValueOnce(ERR_INVALID_TARGET_CODE)
        .mockImplementation((x: number, y: number, structureType: StructureConstant) => {
          constructionSites.push({
            id: `site-${x}-${y}`,
            structureType,
            pos: { x, y, roomName: 'W2N1' }
          } as ConstructionSite);
          return OK_CODE;
        })
    } as unknown as Room;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 405,
      rooms: { W2N1: room },
      spawns: {},
      creeps: {},
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as GameMap
    };

    runEconomy();

    expect(room.lookForAtArea).toHaveBeenCalledWith(LOOK_MINERALS, 15, 15, 31, 31, true);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(23, 23, STRUCTURE_SPAWN);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(22, 22, STRUCTURE_SPAWN);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 23, 22, STRUCTURE_SPAWN);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 24, 22, STRUCTURE_SPAWN);
    expect(Memory.territory?.postClaimBootstraps?.W2N1).toMatchObject({
      status: 'spawnSitePending',
      updatedAt: 405,
      spawnSite: { roomName: 'W2N1', x: 24, y: 22 },
      lastResult: OK_CODE
    });
  });

  it('spawns initial local workers for a post-claim room that already has a spawn', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'detected',
            claimedAt: 410,
            updatedAt: 410,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };
    const room = {
      name: 'W2N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller: { id: 'controller2', my: true, level: 1 } as StructureController,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: 'source1' } as Source] : []))
    } as unknown as Room;
    const spawn = {
      name: 'Spawn2',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 411,
      rooms: { W2N1: room },
      spawns: { Spawn2: spawn },
      creeps: {}
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W2N1-411', {
      memory: { role: 'worker', colony: 'W2N1' }
    });
    expect(Memory.territory?.postClaimBootstraps?.W2N1).toMatchObject({
      status: 'spawningWorkers',
      updatedAt: 411
    });
    const [message] = logSpy.mock.calls[0];
    expect(JSON.parse((message as string).slice(RUNTIME_SUMMARY_PREFIX.length))).toMatchObject({
      events: [
        {
          type: 'spawn',
          roomName: 'W2N1',
          spawnName: 'Spawn2',
          creepName: 'worker-W2N1-411',
          role: 'worker',
          result: OK_CODE
        },
        {
          type: 'postClaimBootstrap',
          roomName: 'W2N1',
          colony: 'W1N1',
          phase: 'workerSpawn',
          spawnName: 'Spawn2',
          creepName: 'worker-W2N1-411',
          result: OK_CODE,
          workerTarget: 2
        }
      ]
    });
  });

  it('uses the home spawn to sustain a post-claim room before that room has an operational spawn', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'spawnSitePending',
            claimedAt: 412,
            updatedAt: 413,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };
    const homeRoom = makeTerritoryReadyEconomyRoom();
    const claimedRoom = {
      name: 'W2N1',
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller: { id: 'controller2', my: true, level: 1 } as StructureController,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: 'remote-source' } as Source] : []))
    } as unknown as Room;
    const spawn = {
      name: 'Spawn1',
      room: homeRoom,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(homeRoom),
      Worker2: makeEconomyWorker(homeRoom),
      Worker3: makeEconomyWorker(homeRoom)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 414,
      rooms: { W1N1: homeRoom, W2N1: claimedRoom },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      ['work', 'carry', 'move'],
      'worker-W2N1-414',
      {
        memory: {
          role: 'worker',
          colony: 'W2N1',
          spawnSupport: { originRoom: 'W1N1', targetRoom: 'W2N1' }
        }
      }
    );
  });

  it('refreshes remote mining setup for claimed expansion rooms during the economy tick', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_STRUCTURES: number;
      FIND_CONSTRUCTION_SITES: number;
      FIND_MY_CREEPS: number;
      STRUCTURE_CONTAINER: StructureConstant;
      STRUCTURE_SPAWN: StructureConstant;
      TERRAIN_MASK_WALL: number;
      OK: ScreepsReturnCode;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 2;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 3;
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 4;
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { OK: ScreepsReturnCode }).OK = OK_CODE;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'ready',
            claimedAt: 420,
            updatedAt: 421,
            workerTarget: 2
          }
        }
      }
    };
    const homeRoom = makeTerritoryReadyEconomyRoom();
    const constructionSites: ConstructionSite[] = [];
    const remoteRoom = {
      name: 'W2N1',
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller: {
        my: true,
        level: 1,
        pos: { x: 25, y: 25, roomName: 'W2N1' } as RoomPosition
      } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [{ id: 'remote-source', pos: { x: 10, y: 10, roomName: 'W2N1' } as RoomPosition } as Source];
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return constructionSites;
        }

        return [];
      }),
      createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
        constructionSites.push({
          id: `site-${x}-${y}`,
          structureType,
          pos: { x, y, roomName: 'W2N1' } as RoomPosition
        } as ConstructionSite);
        return OK_CODE;
      })
    } as unknown as Room & { createConstructionSite: jest.Mock };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 422,
      rooms: { W1N1: homeRoom, W2N1: remoteRoom },
      spawns: {},
      creeps: {
        Worker1: makeEconomyWorker(homeRoom),
        Worker2: makeEconomyWorker(homeRoom),
        Worker3: makeEconomyWorker(homeRoom),
        Worker4: makeEconomyWorker(homeRoom),
        Worker5: makeEconomyWorker(homeRoom)
      },
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as GameMap
    };

    runEconomy();

    expect(remoteRoom.createConstructionSite).toHaveBeenCalledWith(11, 11, STRUCTURE_CONTAINER);
    expect(
      remoteRoom.createConstructionSite.mock.calls.filter(
        ([, , structureType]) => structureType === STRUCTURE_SPAWN
      )
    ).toHaveLength(0);
    expect(Memory.territory?.remoteMining?.['W1N1:W2N1']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      status: 'containerPending',
      sources: {
        'remote-source': {
          sourceId: 'remote-source',
          containerSitePending: true
        }
      }
    });
  });

  it('keeps unsafe occupation recommendations on worker recovery before territory spawn pressure', () => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const room = makeTerritoryReadyEconomyRoom();
    const targetRoom = makeVisibleReserveRoom('W2N1', 'controller2' as Id<StructureController>);
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 321,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn },
      creeps: { Worker1: makeEconomyWorker(room) },
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' }))
      } as unknown as GameMap
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      ['work', 'carry', 'move'],
      'worker-W1N1-321',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it('clears stale recommendation-created territory targets on unsafe hostile ticks', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_HOSTILE_CREEPS: number;
      FIND_HOSTILE_STRUCTURES: number;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'reserve',
            createdBy: 'occupationRecommendation',
            controllerId: 'controller2' as Id<StructureController>
          },
          { colony: 'W1N1', roomName: 'W3N1', action: 'claim' },
          {
            colony: 'W1N1',
            roomName: 'W4N1',
            action: 'reserve',
            createdBy: 'occupationRecommendation',
            enabled: false
          },
          {
            colony: 'W9N9',
            roomName: 'W9N8',
            action: 'reserve',
            createdBy: 'occupationRecommendation'
          }
        ],
        routeDistances: { 'W1N1>W3N1': null }
      }
    };
    const hostile = { id: 'hostile1' } as Creep;
    const room = makeHostileEconomyRoom([hostile]);
    const targetRoom = makeVisibleReserveRoom('W2N1', 'controller2' as Id<StructureController>);
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as StructureSpawn;
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 322,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: { Spawn1: spawn },
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' }))
      } as unknown as GameMap
    };

    runEconomy();

    expect(Memory.territory?.targets).toEqual([
      { colony: 'W1N1', roomName: 'W3N1', action: 'claim' },
      {
        colony: 'W1N1',
        roomName: 'W4N1',
        action: 'reserve',
        createdBy: 'occupationRecommendation',
        enabled: false
      },
      {
        colony: 'W9N9',
        roomName: 'W9N8',
        action: 'reserve',
        createdBy: 'occupationRecommendation'
      }
    ]);
  });
});

interface LifecycleSpawn extends StructureSpawn {
  spawnCreep: jest.Mock<ScreepsReturnCode, Parameters<StructureSpawn['spawnCreep']>>;
  advanceSpawnLifecycle(): void;
}

function createLifecycleSpawn(room: Room, creeps: Record<string, Creep>, spawnTime: number): LifecycleSpawn {
  let spawning: Spawning | null = null;
  let pendingMemory: CreepMemory | undefined;

  const spawn = {
    name: 'Spawn1',
    room,
    get spawning(): Spawning | null {
      return spawning;
    },
    spawnCreep: jest.fn((body: BodyPartConstant[], name: string, options?: SpawnOptions) => {
      if (spawning) {
        return ERR_BUSY_CODE;
      }

      pendingMemory = options?.memory;
      spawning = { name, remainingTime: spawnTime } as Spawning;
      return OK_CODE;
    }),
    advanceSpawnLifecycle: () => {
      if (!spawning) {
        return;
      }

      spawning = { ...spawning, remainingTime: spawning.remainingTime - 1 } as Spawning;
      if (spawning.remainingTime > 0) {
        return;
      }

      creeps[spawning.name] = {
        name: spawning.name,
        memory: pendingMemory ?? {}
      } as Creep;
      spawning = null;
      pendingMemory = undefined;
    }
  };

  return spawn as unknown as LifecycleSpawn;
}

function makeTerritoryReadyEconomyRoom(options: {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): Room {
  const energyCapacityAvailable = options.energyCapacityAvailable ?? 650 + MIN_SPAWN_ENERGY_BUFFER;
  const energyAvailable = Math.min(options.energyAvailable ?? energyCapacityAvailable, energyCapacityAvailable);

  return {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: 'home-source' } as Source] : []))
  } as unknown as Room;
}

function makeOwnedEconomyRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: {
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: `${roomName}-source` } as Source] : []))
  } as unknown as Room;
}

function installSpawnCoordinationGlobals(): void {
  (globalThis as unknown as {
    FIND_SOURCES: number;
    FIND_MY_STRUCTURES: number;
    FIND_MY_CONSTRUCTION_SITES: number;
    FIND_CONSTRUCTION_SITES: number;
    STRUCTURE_EXTENSION: StructureConstant;
  }).FIND_SOURCES = 1;
  (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 2;
  (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 3;
  (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 4;
  (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
}

function makeSpawnCoordinationRoom({
  roomName,
  energyAvailable,
  energyCapacityAvailable,
  controllerLevel = 3
}: {
  roomName: string;
  energyAvailable: number;
  energyCapacityAvailable: number;
  controllerLevel?: number;
}): Room {
  return {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      id: `${roomName}-controller`,
      my: true,
      owner: { username: 'me' },
      level: controllerLevel,
      ticksToDowngrade: 10_000
    } as StructureController,
    memory: {},
    find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: `${roomName}-source` } as Source] : []))
  } as unknown as Room;
}

function makeStorageEconomyRoom({
  roomName,
  storageEnergy,
  storageCapacity = 1_000,
  energyAvailable,
  energyCapacityAvailable
}: {
  roomName: string;
  storageEnergy: number;
  storageCapacity?: number;
  energyAvailable: number;
  energyCapacityAvailable: number;
}): Room {
  return {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    memory: {},
    storage: {
      id: `${roomName}-storage`,
      structureType: 'storage',
      store: makeEnergyStore(storageEnergy, storageCapacity)
    } as StructureStorage,
    find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: `${roomName}-source` } as Source] : []))
  } as unknown as Room;
}

function makeEnergyStore(energy: number, capacity: number): StoreDefinition {
  return {
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
    getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? capacity : 0)),
    getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
      resource === RESOURCE_ENERGY ? Math.max(0, capacity - energy) : 0
    )
  } as unknown as StoreDefinition;
}

function makeVisibleForeignReservedRoom(
  roomName: string,
  controllerId: Id<StructureController>
): Room {
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController,
    find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: `${roomName}-source` } as Source] : []))
  } as unknown as Room;
}

function makeVisibleReserveRoom(
  roomName: string,
  controllerId: Id<StructureController>
): Room {
  return {
    name: roomName,
    controller: { id: controllerId, my: false } as StructureController,
    find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: `${roomName}-source` } as Source] : []))
  } as unknown as Room;
}

function makeVisibleExpansionScoringRoom(
  roomName: string,
  controllerId: Id<StructureController>
): Room {
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my: false,
      pos: { x: 25, y: 25 } as RoomPosition
    } as StructureController,
    find: jest.fn((type: number) =>
      type === FIND_SOURCES
        ? Array.from(
            { length: 2 },
            (_value, index) =>
              ({
                id: `${roomName}-source${index}`,
                pos: { x: 20 + index * 5, y: 20 + index * 5 } as RoomPosition
              }) as Source
          )
        : []
    )
  } as unknown as Room;
}

function makeHostileEconomyRoom(hostileCreeps: Creep[]): Room {
  const room = makeTerritoryReadyEconomyRoom();
  return {
    ...room,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return [{ id: 'home-source' } as Source];
      }

      if (type === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
      }

      return [];
    })
  } as unknown as Room;
}

function makeEconomyWorker(room: Room): Creep {
  return {
    memory: { role: 'worker', colony: room.name },
    room,
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(0),
      getFreeCapacity: jest.fn().mockReturnValue(50)
    }
  } as unknown as Creep;
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
