import { runWorker } from '../src/creeps/workerRunner';
import { CONTROLLER_DOWNGRADE_GUARD_TICKS, IDLE_RAMPART_REPAIR_HITS_CEILING } from '../src/tasks/workerTasks';
import { TERRITORY_RESERVATION_RENEWAL_TICKS } from '../src/territory/territoryPlanner';

function withRangeTo<T extends { id: string }>(object: T, rangesByTargetId: Record<string, number>): T {
  return {
    ...object,
    pos: {
      getRangeTo: jest.fn((target: RoomObject) => rangesByTargetId[String((target as { id?: string }).id)] ?? 99)
    }
  };
}

describe('runWorker', () => {
  beforeEach(() => {
    (globalThis as unknown as { ERR_NOT_IN_RANGE: number; ERR_FULL: number; RESOURCE_ENERGY: ResourceConstant; FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; FIND_MY_STRUCTURES: number; FIND_DROPPED_RESOURCES: number; FIND_STRUCTURES: number; STRUCTURE_SPAWN: StructureConstant; STRUCTURE_EXTENSION: StructureConstant; STRUCTURE_ROAD: StructureConstant; STRUCTURE_CONTAINER: StructureConstant; STRUCTURE_STORAGE: StructureConstant; STRUCTURE_TERMINAL: StructureConstant; STRUCTURE_RAMPART: StructureConstant }).ERR_NOT_IN_RANGE = -9;
    (globalThis as unknown as { ERR_FULL: number }).ERR_FULL = -8;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { FIND_DROPPED_RESOURCES: number }).FIND_DROPPED_RESOURCES = 4;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_ROAD: StructureConstant }).STRUCTURE_ROAD = 'road';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { STRUCTURE_RAMPART: StructureConstant }).STRUCTURE_RAMPART = 'rampart';
    (globalThis as unknown as { CLAIM: BodyPartConstant }).CLAIM = 'claim';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {} };
  });

  it('assigns a task when the creep has none', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      memory: {},
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([source]) }
    } as unknown as Creep;

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('splits empty workers across sources as harvest assignments change', () => {
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([source1, source2])
    } as unknown as Room;
    const assigned = {
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      room
    } as unknown as Creep;
    const worker1 = {
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;
    const worker2 = {
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Assigned: assigned, Worker1: worker1, Worker2: worker2 }
    };

    runWorker(worker1);
    runWorker(worker2);

    expect(worker1.memory.task).toEqual({ type: 'harvest', targetId: 'source2' });
    expect(worker2.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('leaves worker untasked when it has no energy and no sources', () => {
    const creep = {
      memory: {},
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;

    expect(() => runWorker(creep)).not.toThrow();
    expect(creep.memory.task).toBeUndefined();
  });

  it('leaves worker untasked when it has energy and no spending targets or controller', () => {
    const creep = {
      memory: {},
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;

    expect(() => runWorker(creep)).not.toThrow();
    expect(creep.memory.task).toBeUndefined();
  });

  it('moves toward harvest target when not in range', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' } },
      harvest: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(source)
    };

    runWorker(creep);

    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).toHaveBeenCalledWith(source);
  });

  it('picks up dropped energy and moves when not in range', () => {
    const droppedEnergy = { id: 'drop1', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const creep = {
      memory: { task: { type: 'pickup', targetId: 'drop1' as Id<Resource<ResourceConstant>> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pickup: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(droppedEnergy)
    };

    runWorker(creep);

    expect(creep.pickup).toHaveBeenCalledWith(droppedEnergy);
    expect(creep.moveTo).toHaveBeenCalledWith(droppedEnergy);
  });

  it('transfers energy to a transfer target and moves when not in range', () => {
    const spawn = { id: 'spawn1' } as StructureSpawn;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'spawn1' } },
      transfer: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.moveTo).toHaveBeenCalledWith(spawn);
  });

  it('withdraws energy from a withdraw target and moves when not in range', () => {
    const container = { id: 'container1' } as StructureContainer;
    const creep = {
      memory: { task: { type: 'withdraw', targetId: 'container1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      withdraw: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(container)
    };

    runWorker(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, 'energy');
    expect(creep.moveTo).toHaveBeenCalledWith(container);
  });

  it('builds an existing build target and moves when not in range', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const build = jest.fn().mockReturnValue(-9);
    const moveTo = jest.fn();
    const getObjectById = jest.fn().mockReturnValue(site);
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      build,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('site1');
    expect(build).toHaveBeenCalledWith(site);
    expect(moveTo).toHaveBeenCalledWith(site);
  });

  it('repairs an existing repair target and moves when not in range', () => {
    const road = { id: 'road1', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const repair = jest.fn().mockReturnValue(-9);
    const moveTo = jest.fn();
    const getObjectById = jest.fn().mockReturnValue(road);
    const creep = {
      memory: { task: { type: 'repair', targetId: 'road1' as Id<Structure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      repair,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('road1');
    expect(repair).toHaveBeenCalledWith(road);
    expect(moveTo).toHaveBeenCalledWith(road);
  });

  it('upgrades an existing upgrade target and moves when not in range', () => {
    const controller = { id: 'controller1' } as StructureController;
    const upgradeController = jest.fn().mockReturnValue(-9);
    const moveTo = jest.fn();
    const getObjectById = jest.fn().mockReturnValue(controller);
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      upgradeController,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller1');
    expect(upgradeController).toHaveBeenCalledWith(controller);
    expect(moveTo).toHaveBeenCalledWith(controller);
  });

  it('preempts an RCL2 upgrade task for extension construction when downgrade is safe', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
      },
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn()
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps the RCL2 downgrade guard above upgrade preemption', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
      },
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts an RCL3 upgrade task for extension construction when downgrade is safe', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
      },
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps an RCL3 upgrade task when selection still prefers the same controller', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn().mockReturnValue([])
      },
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts a low-value upgrade task for damaged road repair', () => {
    const road = { id: 'road1', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [road] : []))
      },
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn()
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'road1' });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it.each([
    ['spawn', 'spawn1'],
    ['extension', 'extension1']
  ])('preempts construction for fillable %s energy under spawn pressure', (structureType, id) => {
    const site = { id: 'site1' } as ConstructionSite;
    const energySink = {
      id,
      structureType,
      store: { getFreeCapacity: jest.fn().mockReturnValue(50) }
    } as unknown as StructureSpawn | StructureExtension;
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [energySink];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return type === FIND_CONSTRUCTION_SITES ? [site] : [];
          }
        )
      },
      build: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(site)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: id });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps construction work when spawn and extension energy is full', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const fullExtension = {
      id: 'extension1',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureExtension;
    const build = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [fullSpawn, fullExtension];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return type === FIND_CONSTRUCTION_SITES ? [site] : [];
          }
        )
      },
      build,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(site)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(Game.getObjectById).toHaveBeenCalledWith('site1');
    expect(build).toHaveBeenCalledWith(site);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps controller upgrade work when spawn and extension energy is full', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const fullExtension = {
      id: 'extension1',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureExtension;
    const upgradeController = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [fullSpawn, fullExtension];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return [];
          }
        )
      },
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(Game.getObjectById).toHaveBeenCalledWith('controller1');
    expect(upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('clears missing build targets and reassigns without building the stale target', () => {
    const site = { id: 'site2' } as ConstructionSite;
    const build = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'build', targetId: 'missing' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn((type) => (type === 2 ? [site] : [])) },
      build,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('missing');
    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site2' });
    expect(build).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('reassigns stale upgrade tasks when selection chooses a different controller', () => {
    const controller = { id: 'controller2', my: true } as StructureController;
    const upgradeController = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'missing' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller, find: jest.fn().mockReturnValue([]) },
      upgradeController,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).not.toHaveBeenCalled();
    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller2' });
    expect(upgradeController).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('preempts local construction when a claimed territory target needs upgrade support', () => {
    const controller = { id: 'controller2', my: true, level: 1 } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 200 }]
      }
    };
    const room = {
      name: 'W2N1',
      controller,
      find: jest.fn((type: number) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
    } as unknown as Room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1', task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(site);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).not.toHaveBeenCalled();
    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller2' });
    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('executes a normal-threshold reservation task for a one-CLAIM worker', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 201 }]
      }
    };
    const room = {
      name: 'W2N1',
      controller,
      find: jest.fn((type: number) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
    } as unknown as Room;
    const creep = {
      owner: { username: 'me' },
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'reserve', targetId: 'controller2' as Id<StructureController> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      reserveController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller2');
    expect(creep.memory.task).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('clears completed repair targets and reassigns without repairing the stale target', () => {
    const fullRoad = { id: 'road-full', structureType: 'road', hits: 5_000, hitsMax: 5_000 } as StructureRoad;
    const damagedRoad = { id: 'road-damaged', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const repair = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'repair', targetId: 'road-full' as Id<Structure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller: { id: 'controller1', my: true } as StructureController,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [fullRoad, damagedRoad] : []))
      },
      repair,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(fullRoad);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('road-full');
    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'road-damaged' });
    expect(repair).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('clears owned rampart repair targets at the idle ceiling and reassigns without repairing them', () => {
    const rampart = {
      id: 'rampart-ceiling',
      structureType: 'rampart',
      hits: IDLE_RAMPART_REPAIR_HITS_CEILING,
      hitsMax: 300_000_000,
      my: true
    } as StructureRampart;
    const damagedRoad = { id: 'road-damaged', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const repair = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'repair', targetId: 'rampart-ceiling' as Id<Structure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller: { id: 'controller1', my: true } as StructureController,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [rampart, damagedRoad] : []))
      },
      repair,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(rampart);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('rampart-ceiling');
    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'road-damaged' });
    expect(repair).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('clears invalid task targets', () => {
    const creep = {
      memory: { task: { type: 'build', targetId: 'missing' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
  });

  it.each([
    { type: 'harvest', targetId: 'missing-source' as Id<Source> },
    { type: 'pickup', targetId: 'missing-drop' as Id<Resource<ResourceConstant>> },
    { type: 'transfer', targetId: 'missing-transfer' as Id<AnyStoreStructure> },
    { type: 'build', targetId: 'missing-site' as Id<ConstructionSite> },
    { type: 'repair', targetId: 'missing-repair' as Id<Structure> },
    { type: 'upgrade', targetId: 'missing-controller' as Id<StructureController> }
  ] satisfies CreepTaskMemory[])(
    'clears stale $type task in a controllerless room without executing it',
    (task) => {
      const creep = {
        memory: { task },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(task.type === 'harvest' ? 0 : 50),
          getFreeCapacity: jest.fn().mockReturnValue(50)
        },
        room: { find: jest.fn().mockReturnValue([]) },
        harvest: jest.fn(),
        pickup: jest.fn(),
        build: jest.fn(),
        repair: jest.fn(),
        transfer: jest.fn(),
        upgradeController: jest.fn(),
        moveTo: jest.fn()
      } as unknown as Creep;
      const getObjectById = jest.fn().mockReturnValue(null);
      (globalThis as unknown as { Game: Partial<Game> }).Game = { getObjectById };

      expect(() => runWorker(creep)).not.toThrow();

      expect(getObjectById).toHaveBeenCalledWith(task.targetId);
      expect(creep.memory.task).toBeUndefined();
      expect(creep.harvest).not.toHaveBeenCalled();
      expect(creep.pickup).not.toHaveBeenCalled();
      expect(creep.build).not.toHaveBeenCalled();
      expect(creep.repair).not.toHaveBeenCalled();
      expect(creep.transfer).not.toHaveBeenCalled();
      expect(creep.upgradeController).not.toHaveBeenCalled();
      expect(creep.moveTo).not.toHaveBeenCalled();
    }
  );

  it('switches from harvest when creep is full', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn((type) => (type === 3 ? [spawn] : [])) }
    } as unknown as Creep;

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('preempts an empty harvest trip for faster local spawn recovery energy', () => {
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 5 });
    const droppedEnergy = withRangeTo(
      { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-near': 1,
        source1: 2,
        spawn1: 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [spawn];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            if (type === FIND_DROPPED_RESOURCES) {
              return [droppedEnergy];
            }

            if (type === FIND_STRUCTURES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
              return [];
            }

            return type === FIND_SOURCES ? [source] : [];
          }
        )
      },
      harvest: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(source)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('switches from spending tasks when creep is empty', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn().mockReturnValue([source]) }
    } as unknown as Creep;

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('transfers energy to transfer targets', () => {
    const spawn = { id: 'spawn1' } as StructureSpawn;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('reselects a worker task without moving when transfer returns ERR_FULL', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValueOnce(1).mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === 3) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === 2 ? [site] : [];
        })
      },
      transfer: jest.fn().mockReturnValue(ERR_FULL),
      moveTo: jest.fn(),
      build: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.build).not.toHaveBeenCalled();
  });
});
