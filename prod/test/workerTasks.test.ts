import { selectWorkerTask } from '../src/tasks/workerTasks';

describe('selectWorkerTask', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; FIND_MY_STRUCTURES: number; RESOURCE_ENERGY: ResourceConstant; STRUCTURE_SPAWN: StructureConstant; STRUCTURE_EXTENSION: StructureConstant }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
  });

  it('selects harvest when worker has no energy', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([source]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('selects transfer when worker has energy and spawn needs energy', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn((type) => (type === 3 ? [spawn] : [])) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('selects build when worker has energy and construction sites exist', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn((type) => (type === 2 ? [site] : [])) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('selects upgrade when worker has energy and no construction sites exist', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { controller, find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });
});
