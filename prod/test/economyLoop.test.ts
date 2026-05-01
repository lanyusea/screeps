import { runEconomy } from '../src/economy/economyLoop';
import { CONTROLLER_DOWNGRADE_GUARD_TICKS } from '../src/tasks/workerTasks';
import { RUNTIME_SUMMARY_PREFIX } from '../src/telemetry/runtimeSummary';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_BUSY_CODE = -4 as ScreepsReturnCode;

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
      energyAvailable: 0,
      energyCapacityAvailable: 0,
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
      energyAvailable: 0,
      energyCapacityAvailable: 0,
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

  it('turns a safe occupation recommendation into same-tick territory spawn pressure', () => {
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
          action: 'reserve',
          controllerId: 'controller2'
        }
      }
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
      ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
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
