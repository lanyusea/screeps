import { CONTROLLER_DOWNGRADE_GUARD_TICKS, selectWorkerTask } from '../src/tasks/workerTasks';

describe('selectWorkerTask', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; FIND_MY_STRUCTURES: number; RESOURCE_ENERGY: ResourceConstant; STRUCTURE_SPAWN: StructureConstant; STRUCTURE_EXTENSION: StructureConstant }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { Game?: Partial<Game> }).Game = { creeps: {} };
  });

  it('selects harvest when worker has no energy', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([source]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('selects the least-assigned harvest source for same-room workers', () => {
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([source1, source2])
    } as unknown as Room;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        Assigned: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
          room
        } as unknown as Creep,
        OtherRoom: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source2' as Id<Source> } },
          room: { name: 'W2N2' } as Room
        } as unknown as Creep,
        Miner: {
          memory: { role: 'miner', task: { type: 'harvest', targetId: 'source2' as Id<Source> } },
          room
        } as unknown as Creep,
        Partial: {
          memory: { role: 'worker', task: { type: 'harvest' } as CreepTaskMemory },
          room
        } as unknown as Creep
      }
    };
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('keeps room.find source order as the stable tie-breaker', () => {
    const source2 = { id: 'source2' } as Source;
    const source1 = { id: 'source1' } as Source;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { name: 'W1N1', find: jest.fn().mockReturnValue([source2, source1]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('selects no task when worker has no energy and no sources', () => {
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toBeNull();
  });

  it.each([
    ['spawn', 'spawn1'],
    ['extension', 'extension1']
  ])('selects transfer when worker has energy and %s needs energy', (structureType, id) => {
    const energySink = {
      id,
      structureType,
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn | StructureExtension;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn((type) => (type === 3 ? [energySink] : [])) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: id });
  });

  it('selects build when worker has energy and construction sites exist', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn((type) => (type === 2 ? [site] : [])) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('selects RCL1 controller upgrade before non-spawn construction when downgrade is safe', () => {
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const site = { id: 'site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === 3) {
            const structures = [fullSpawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === 2 ? [site] : [];
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('builds spawn construction before RCL1 controller rush', () => {
    const site = { id: 'spawn-site1', structureType: 'spawn' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'spawn-site1' });
  });

  it('builds spawn construction before RCL1 rush when STRUCTURE_SPAWN is missing from the mock globals', () => {
    delete (globalThis as unknown as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN;
    const site = { id: 'spawn-site1', structureType: 'spawn' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toEqual({ type: 'build', targetId: 'spawn-site1' });
  });

  it.each([
    ['road', 'road-site1'],
    ['container', 'container-site1']
  ])('selects RCL2 controller upgrade before non-critical %s construction when downgrade is safe', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it.each([
    ['spawn', 'spawn-site1'],
    ['extension', 'extension-site1']
  ])('builds RCL2 critical %s construction before controller progress guard', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it('builds RCL2 extension construction before controller progress guard when STRUCTURE_EXTENSION is missing', () => {
    delete (globalThis as unknown as { STRUCTURE_EXTENSION?: StructureConstant }).STRUCTURE_EXTENSION;
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('keeps RCL3 build-before-upgrade priority when controller downgrade is safe', () => {
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-site1' });
  });

  it('keeps low-downgrade guard above construction at RCL2', () => {
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps spawn refill priority over RCL1 controller rush', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const site = { id: 'site1' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === 3) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === 2 ? [site] : [];
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps spawn refill priority over the downgrade guard', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const site = { id: 'site1' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === 3) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === 2 ? [site] : [];
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps build priority for low downgrade data on unowned controllers', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: false,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('keeps build priority when owned controller downgrade data is missing', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const controller = { id: 'controller1', my: true } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('selects upgrade when worker has energy and no construction sites exist', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { controller, find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps carried-energy fallback order as transfer, build, then upgrade', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const site = { id: 'site1' } as ConstructionSite;
    const controller = { id: 'controller1', my: true } as StructureController;
    const makeCreep = (room: Room): Creep =>
      ({
        store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
        room
      }) as unknown as Creep;

    const roomWithSink = {
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === 3) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return type === 2 ? [site] : [];
      })
    } as unknown as Room;
    const roomWithSite = {
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === 3) {
          const structures = [fullSpawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return type === 2 ? [site] : [];
      })
    } as unknown as Room;
    const roomWithController = {
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;

    expect(selectWorkerTask(makeCreep(roomWithSink))).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(selectWorkerTask(makeCreep(roomWithSite))).toEqual({ type: 'build', targetId: 'site1' });
    expect(selectWorkerTask(makeCreep(roomWithController))).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('selects no task when worker has energy and the room has no spending targets or controller', () => {
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toBeNull();
  });
});
