import { runEconomy } from '../src/economy/economyLoop';
import { CONTROLLER_DOWNGRADE_GUARD_TICKS } from '../src/tasks/workerTasks';
import { RUNTIME_SUMMARY_PREFIX } from '../src/telemetry/runtimeSummary';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_BUSY_CODE = -4 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;

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

  it('spawns an emergency worker when an owned colony has zero creeps and only basic worker energy', () => {
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
      ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      'worker-W1N1-126',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
    expect(spawn2.spawnCreep).toHaveBeenCalledWith(
      ['work', 'carry', 'move', 'work', 'carry', 'move'],
      'worker-W1N1-126-2',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
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
      energyAvailable: 400,
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

    expect(spawn.spawnCreep).toHaveBeenCalledWith(
      ['work', 'carry', 'move', 'work', 'carry', 'move'],
      'worker-W1N1-127',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    );
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

    room.energyAvailable = 200;
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
      energyAvailable: 500,
      energyCapacityAvailable: 500,
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
      creeps: { Worker1: worker },
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
      energyAvailable: 500,
      energyCapacityAvailable: 500,
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
      creeps: { Worker1: worker },
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

  it('plans tower construction for an owned expansion room before lower-priority sites', () => {
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

    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(24, 24, STRUCTURE_TOWER);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(expect.any(Number), expect.any(Number), STRUCTURE_CONTAINER);
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
    const room = makeTerritoryReadyEconomyRoom();
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

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['claim', 'move'], 'claimer-W1N1-W2N1-320', {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'claim',
          controllerId: 'controller2'
        }
      }
    });
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
    const room = makeTerritoryReadyEconomyRoom();
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    const getRoomTerrain = jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 501,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: {},
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain
      } as unknown as GameMap
    };

    runEconomy();

    expect(getRoomTerrain).toHaveBeenCalledTimes(1);
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
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller2'
      }
    ]);

    getRoomTerrain.mockImplementation(() => {
      throw new Error('next expansion scoring should reuse the cached selection between refresh ticks');
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 502;

    runEconomy();

    expect(getRoomTerrain).toHaveBeenCalledTimes(1);
    expect(room.memory.lastExpansionScoreTime).toBe(501);
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
    const room = makeTerritoryReadyEconomyRoom();
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    const getRoomTerrain = jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 501,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: {},
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain
      } as unknown as GameMap
    };

    runEconomy();

    room.energyCapacityAvailable = 700;
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 502;

    runEconomy();

    expect(getRoomTerrain).toHaveBeenCalledTimes(2);
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
    const room = makeTerritoryReadyEconomyRoom();
    const targetRoom = makeVisibleExpansionScoringRoom('W2N1', 'controller2' as Id<StructureController>);
    const workers = {
      Worker1: makeEconomyWorker(room),
      Worker2: makeEconomyWorker(room),
      Worker3: makeEconomyWorker(room)
    };
    const getRoomTerrain = jest.fn(() => ({ get: jest.fn().mockReturnValue(0) } as unknown as RoomTerrain));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 501,
      rooms: { W1N1: room, W2N1: targetRoom },
      spawns: {},
      creeps: workers,
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain
      } as unknown as GameMap
    };

    runEconomy();

    (globalThis as unknown as { Game: Partial<Game> }).Game.rooms = {
      W1N1: room,
      W2N1: targetRoom,
      W3N1: makeOwnedEconomyRoom('W3N1')
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 502;

    runEconomy();

    expect(getRoomTerrain).toHaveBeenCalledTimes(2);
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
      ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
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
      ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
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

    expect(room.lookForAtArea).toHaveBeenCalledWith(LOOK_STRUCTURES, 2, 2, 47, 47, true);
    expect(room.lookForAtArea).toHaveBeenCalledWith(LOOK_CONSTRUCTION_SITES, 2, 2, 47, 47, true);
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

    expect(room.lookForAtArea).toHaveBeenCalledWith(LOOK_MINERALS, 2, 2, 47, 47, true);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(23, 23, STRUCTURE_SPAWN);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 22, 22, STRUCTURE_SPAWN);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 23, 22, STRUCTURE_SPAWN);
    expect(Memory.territory?.postClaimBootstraps?.W2N1).toMatchObject({
      status: 'spawnSitePending',
      updatedAt: 405,
      spawnSite: { roomName: 'W2N1', x: 23, y: 22 },
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
      ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      'worker-W1N1-W2N1-upgrader-414',
      {
        memory: {
          role: 'worker',
          colony: 'W2N1',
          territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller2' },
          controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' }
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
      TERRAIN_MASK_WALL: number;
      OK: ScreepsReturnCode;
      Memory: Partial<Memory>;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 2;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 3;
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 4;
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
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
      creeps: {},
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as GameMap
    };

    runEconomy();

    expect(remoteRoom.createConstructionSite).toHaveBeenCalledWith(11, 11, STRUCTURE_CONTAINER);
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
      ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
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

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['tough', 'attack', 'move'], 'defender-W1N1-322', {
      memory: {
        role: 'defender',
        colony: 'W1N1',
        defense: { homeRoom: 'W1N1' }
      }
    });
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

function makeTerritoryReadyEconomyRoom({
  energyAvailable = 650,
  energyCapacityAvailable = 650
}: {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): Room {
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
        ? [{ id: `${roomName}-source`, pos: { x: 20, y: 20 } as RoomPosition } as Source]
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
