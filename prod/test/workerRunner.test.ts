import { runWorker } from '../src/creeps/workerRunner';

describe('runWorker', () => {
  beforeEach(() => {
    (globalThis as unknown as { ERR_NOT_IN_RANGE: number; ERR_FULL: number; RESOURCE_ENERGY: ResourceConstant; FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; FIND_MY_STRUCTURES: number; STRUCTURE_SPAWN: StructureConstant; STRUCTURE_EXTENSION: StructureConstant }).ERR_NOT_IN_RANGE = -9;
    (globalThis as unknown as { ERR_FULL: number }).ERR_FULL = -8;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
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

  it('clears missing upgrade targets and reassigns without upgrading the stale target', () => {
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

    expect(getObjectById).toHaveBeenCalledWith('missing');
    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller2' });
    expect(upgradeController).not.toHaveBeenCalled();
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
