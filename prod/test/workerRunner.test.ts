import { runWorker } from '../src/creeps/workerRunner';

describe('runWorker', () => {
  beforeEach(() => {
    (globalThis as unknown as { ERR_NOT_IN_RANGE: number; RESOURCE_ENERGY: ResourceConstant; FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number }).ERR_NOT_IN_RANGE = -9;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
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

  it('clears invalid task targets', () => {
    const creep = {
      memory: { task: { type: 'build', targetId: 'missing' as Id<ConstructionSite> } }
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
});
