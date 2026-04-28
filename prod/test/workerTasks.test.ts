import {
  CONTROLLER_DOWNGRADE_GUARD_TICKS,
  CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO,
  IDLE_RAMPART_REPAIR_HITS_CEILING,
  TOWER_REFILL_ENERGY_FLOOR,
  URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
  selectWorkerTask
} from '../src/tasks/workerTasks';
import {
  TERRITORY_RESERVATION_COMFORT_TICKS,
  TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS,
  TERRITORY_RESERVATION_RENEWAL_TICKS
} from '../src/territory/territoryPlanner';

type TestEnergySink = StructureSpawn | StructureExtension | StructureTower;

function makeLoadedWorker(room: Room, task?: CreepTaskMemory): Creep {
  return {
    memory: { role: 'worker', ...(task ? { task } : {}) },
    store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
    room
  } as unknown as Creep;
}

function setGameCreeps(creeps: Record<string, Creep>): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps };
}

function makeStructure(
  id: string,
  structureType: StructureConstant,
  hits: number,
  hitsMax: number,
  extra: Partial<StructureRampart> = {}
): AnyStructure {
  return { id, structureType, hits, hitsMax, ...extra } as unknown as AnyStructure;
}

function makeEnergySink(
  id: string,
  structureType: StructureConstant,
  freeCapacity: number
): TestEnergySink {
  return {
    id,
    structureType,
    store: { getFreeCapacity: jest.fn().mockReturnValue(freeCapacity) }
  } as unknown as TestEnergySink;
}

function makeTowerEnergySink(id: string, usedEnergy: number, freeCapacity: number): StructureTower {
  return {
    id,
    structureType: 'tower',
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(usedEnergy),
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity)
    }
  } as unknown as StructureTower;
}

function withRangeTo<T extends { id: string }>(object: T, rangesByTargetId: Record<string, number>): T {
  return {
    ...object,
    pos: {
      getRangeTo: jest.fn((target: RoomObject) => rangesByTargetId[String((target as { id?: string }).id)] ?? 99)
    }
  };
}

function makeStoredEnergyStructure(
  id: string,
  structureType: StructureConstant,
  energy: number,
  extra: Record<string, unknown> = {}
): StructureContainer | StructureStorage | StructureTerminal {
  return {
    id,
    structureType,
    store: { getUsedCapacity: jest.fn().mockReturnValue(energy) },
    ...extra
  } as unknown as StructureContainer | StructureStorage | StructureTerminal;
}

function makeSalvageEnergySource(
  id: string,
  energy: number,
  extraResourceAmount = 0
): Tombstone | Ruin {
  return {
    id,
    store: {
      getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : extraResourceAmount))
    }
  } as unknown as Tombstone | Ruin;
}

function makeWorkerTaskRoom({
  constructionSites = [],
  controller = { id: 'controller1', my: true, level: 3 } as StructureController,
  energyAvailable,
  myStructures = [],
  structures = []
}: {
  constructionSites?: ConstructionSite[];
  controller?: StructureController;
  energyAvailable?: number;
  myStructures?: AnyOwnedStructure[];
  structures?: AnyStructure[];
} = {}): Room {
  return {
    name: 'W1N1',
    controller,
    ...(energyAvailable === undefined ? {} : { energyAvailable }),
    find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        return options?.filter ? myStructures.filter(options.filter) : myStructures;
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      return [];
    })
  } as unknown as Room;
}

describe('selectWorkerTask', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; FIND_MY_STRUCTURES: number; FIND_DROPPED_RESOURCES: number; FIND_STRUCTURES: number; FIND_HOSTILE_CREEPS: number; FIND_HOSTILE_STRUCTURES: number; RESOURCE_ENERGY: ResourceConstant; STRUCTURE_SPAWN: StructureConstant; STRUCTURE_EXTENSION: StructureConstant; STRUCTURE_TOWER: StructureConstant; STRUCTURE_ROAD: StructureConstant; STRUCTURE_CONTAINER: StructureConstant; STRUCTURE_STORAGE: StructureConstant; STRUCTURE_TERMINAL: StructureConstant; STRUCTURE_RAMPART: StructureConstant }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { FIND_DROPPED_RESOURCES: number }).FIND_DROPPED_RESOURCES = 4;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { FIND_TOMBSTONES: number }).FIND_TOMBSTONES = 8;
    (globalThis as unknown as { FIND_RUINS: number }).FIND_RUINS = 9;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
    (globalThis as unknown as { STRUCTURE_ROAD: StructureConstant }).STRUCTURE_ROAD = 'road';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { STRUCTURE_RAMPART: StructureConstant }).STRUCTURE_RAMPART = 'rampart';
    (globalThis as unknown as { CLAIM: BodyPartConstant }).CLAIM = 'claim';
    (globalThis as unknown as { WORK: BodyPartConstant }).WORK = 'work';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
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

  it('selects the best range-aware dropped energy before harvesting when worker has free capacity', () => {
    const lowValueDroppedEnergy = { id: 'drop-low', resourceType: 'energy', amount: 24 } as Resource<ResourceConstant>;
    const farDroppedEnergy = { id: 'drop-far', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const nearDroppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: Resource<ResourceConstant>) => {
      const ranges: Record<string, number> = {
        'drop-far': 10,
        'drop-near': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [lowValueDroppedEnergy, farDroppedEnergy, nearDroppedEnergy];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(getRangeTo).not.toHaveBeenCalledWith(lowValueDroppedEnergy);
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('falls back to harvesting when visible dropped energy is not reachable', () => {
    const blockedDroppedEnergy = { id: 'drop-blocked', resourceType: 'energy', amount: 200 } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [blockedDroppedEnergy];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id: string }) => (target.id === 'drop-blocked' ? 5 : 1)),
        findPathTo: jest.fn().mockReturnValue([])
      },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.pos.findPathTo).toHaveBeenCalledWith(blockedDroppedEnergy, { ignoreCreeps: true });
  });

  it('bounds dropped energy path checks while preserving nearby pickup preference', () => {
    const farDroppedEnergy = Array.from(
      { length: 8 },
      (_, index) =>
        ({
          id: `drop-far-${index}`,
          resourceType: 'energy',
          amount: 1_000 + index
        }) as Resource<ResourceConstant>
    );
    const nearDroppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const droppedResources = [...farDroppedEnergy, nearDroppedEnergy];
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      if (target.id === 'drop-near') {
        return 2;
      }

      const index = Number(target.id.replace('drop-far-', ''));
      return Number.isFinite(index) ? 10 + index : 99;
    });
    const findPathTo = jest.fn((target: { id: string }) => (target.id === 'drop-near' ? [{}] : []));
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return droppedResources;
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo, findPathTo },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(findPathTo.mock.calls.length).toBeLessThan(droppedResources.length);
    expect(findPathTo).not.toHaveBeenCalledWith(farDroppedEnergy[7], { ignoreCreeps: true });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('keeps dropped energy fallback deterministic when energy globals or stores are partially mocked', () => {
    delete (globalThis as unknown as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
    const partialContainer = { id: 'container1', structureType: 'container' } as AnyStructure;
    const droppedEnergy = { id: 'drop1', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_STRUCTURES) {
        return [partialContainer];
      }

      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop1' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('uses the fastest local recoverable energy path under spawn pressure', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = withRangeTo(
      { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const richStorage = withRangeTo(
      makeStoredEnergyStructure('storage-rich', 'storage' as StructureConstant, 1_000, { my: true }),
      { spawn1: 8 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 5 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-near': 1,
        source1: 2,
        'storage-rich': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return type === FIND_DROPPED_RESOURCES ? [droppedEnergy] : [];
        }

        if (type === FIND_STRUCTURES) {
          return [richStorage];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
  });

  it('uses dropped energy when it ties harvest delivery under spawn pressure', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 50);
    const droppedEnergy = withRangeTo(
      { id: 'drop-equal', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-equal': 1,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts: jest.fn().mockReturnValue(50),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-equal' });
  });

  it('uses stored energy when it ties harvest delivery under extension pressure', () => {
    const extension = makeEnergySink('extension1', 'extension' as StructureConstant, 50);
    const storedEnergy = withRangeTo(
      makeStoredEnergyStructure('storage-equal', 'storage' as StructureConstant, 50, { my: true }),
      { extension1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { extension1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'storage-equal': 1,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [extension as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [storedEnergy];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts: jest.fn().mockReturnValue(50),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-equal' });
  });

  it('uses salvage energy when it ties harvest delivery under extension pressure', () => {
    const extension = makeEnergySink('extension1', 'extension' as StructureConstant, 50);
    const salvageEnergy = withRangeTo(makeSalvageEnergySource('tombstone-equal', 50), { extension1: 1 });
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { extension1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'tombstone-equal': 1,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [extension as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_TOMBSTONES) {
          return [salvageEnergy];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts: jest.fn().mockReturnValue(50),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'tombstone-equal' });
  });

  it('uses recoverable dropped energy under spawn pressure when the creep has no active work parts', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = withRangeTo(
      { id: 'drop-recoverable', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-recoverable': 30,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const getActiveBodyparts = jest.fn().mockReturnValue(0);
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        if (
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-recoverable' });
    expect(getActiveBodyparts).toHaveBeenCalledWith('work');
  });

  it('uses recoverable stored energy under spawn pressure when the creep has no active work parts', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storedEnergy = withRangeTo(
      makeStoredEnergyStructure('storage-recoverable', 'storage' as StructureConstant, 1_000, { my: true }),
      { spawn1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'storage-recoverable': 30,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const getActiveBodyparts = jest.fn().mockReturnValue(0);
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [storedEnergy];
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-recoverable' });
    expect(getActiveBodyparts).toHaveBeenCalledWith('work');
  });

  it('keeps dropped energy recoverable under spawn pressure when harvest sources are empty', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = withRangeTo(
      { id: 'drop-recoverable', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 15 }
    );
    const emptySource = withRangeTo(
      { id: 'source-empty', energy: 0, ticksToRegeneration: 100 } as Source,
      { spawn1: 1 }
    );
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-recoverable': 15,
        'source-empty': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        if (type === FIND_STRUCTURES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        return type === FIND_SOURCES ? [emptySource] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-recoverable' });
  });

  it('keeps stored energy recoverable under spawn pressure when harvest sources are empty', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storedEnergy = withRangeTo(
      makeStoredEnergyStructure('storage-recoverable', 'storage' as StructureConstant, 1_000, { my: true }),
      { spawn1: 15 }
    );
    const emptySource = withRangeTo(
      { id: 'source-empty', energy: 0, ticksToRegeneration: 100 } as Source,
      { spawn1: 1 }
    );
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'source-empty': 1,
        'storage-recoverable': 15
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        if (type === FIND_STRUCTURES) {
          return [storedEnergy];
        }

        return type === FIND_SOURCES ? [emptySource] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-recoverable' });
  });

  it('falls back to harvesting under spawn pressure when recoverable energy cannot beat a harvest trip', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const farStorage = withRangeTo(
      makeStoredEnergyStructure('storage-far', 'storage' as StructureConstant, 1_000, { my: true }),
      { spawn1: 100 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: 1,
        'storage-far': 100
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        if (type === FIND_STRUCTURES) {
          return [farStorage];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('falls back to harvesting under spawn pressure when empty sources have no recoverable energy', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const emptySource = withRangeTo(
      { id: 'source-empty', energy: 0, ticksToRegeneration: 100 } as Source,
      { spawn1: 1 }
    );
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'source-empty': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [emptySource] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-empty' });
  });

  it('selects withdraw from safe stored energy before harvesting', () => {
    const container = makeStoredEnergyStructure('container1', 'container' as StructureConstant, 100);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 200, { my: true });
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container, storage];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage1' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('prefers much richer safe stored energy over nearby tiny stored energy', () => {
    const nearbyTinyContainer = makeStoredEnergyStructure('container-tiny', 'container' as StructureConstant, 25);
    const richStorage = makeStoredEnergyStructure('storage-rich', 'storage' as StructureConstant, 1_000, { my: true });
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: StructureContainer | StructureStorage) => {
      const ranges: Record<string, number> = {
        'container-tiny': 1,
        'storage-rich': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [nearbyTinyContainer, richStorage];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-rich' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('keeps closest safe stored energy when stored amounts are comparable', () => {
    const nearbyContainer = makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 100);
    const fartherStorage = makeStoredEnergyStructure('storage-far', 'storage' as StructureConstant, 150, { my: true });
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: StructureContainer | StructureStorage) => {
      const ranges: Record<string, number> = {
        'container-near': 1,
        'storage-far': 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [fartherStorage, nearbyContainer];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-near' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('breaks equal stored energy score ties by id', () => {
    const secondContainer = makeStoredEnergyStructure('container-b', 'container' as StructureConstant, 100);
    const firstContainer = makeStoredEnergyStructure('container-a', 'container' as StructureConstant, 100);
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn().mockReturnValue(2);
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [secondContainer, firstContainer];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-a' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('ignores hostile-owned stored energy even when it would score higher', () => {
    const safeContainer = makeStoredEnergyStructure('container-safe', 'container' as StructureConstant, 50);
    const hostileStorage = makeStoredEnergyStructure('storage-hostile', 'storage' as StructureConstant, 10_000, {
      my: false
    });
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: StructureContainer | StructureStorage) => {
      const ranges: Record<string, number> = {
        'container-safe': 6,
        'storage-hostile': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [hostileStorage, safeContainer];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-safe' });
    expect(getRangeTo).not.toHaveBeenCalledWith(hostileStorage);
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('selects withdraw from a reserved remote container before harvesting', () => {
    const container = makeStoredEnergyStructure('remote-container', 'container' as StructureConstant, 100);
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      owner: { username: 'me' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: {
        controller: { my: false, reservation: { username: 'me' } },
        find: roomFind
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'remote-container' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('selects withdraw from a neutral non-hostile container before harvesting', () => {
    const container = makeStoredEnergyStructure('neutral-container', 'container' as StructureConstant, 100);
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller: { my: false }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'neutral-container' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it.each(['tombstone', 'ruin'] as const)('selects withdraw from %s energy before harvesting', (sourceKind) => {
    const salvageEnergy = makeSalvageEnergySource(`${sourceKind}1`, 25);
    const source = { id: 'source1' } as Source;
    const salvageFindType = sourceKind === 'tombstone' ? FIND_TOMBSTONES : FIND_RUINS;
    const otherSalvageFindType = sourceKind === 'tombstone' ? FIND_RUINS : FIND_TOMBSTONES;
    const roomFind = jest.fn((type: number) => {
      if (
        type === FIND_DROPPED_RESOURCES ||
        type === FIND_STRUCTURES ||
        type === FIND_HOSTILE_CREEPS ||
        type === FIND_HOSTILE_STRUCTURES ||
        type === otherSalvageFindType
      ) {
        return [];
      }

      if (type === salvageFindType) {
        return [salvageEnergy];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: `${sourceKind}1` });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('ignores empty, non-energy, and trivial tombstone or ruin stores before balanced harvesting', () => {
    const emptyTombstone = makeSalvageEnergySource('tombstone-empty', 0);
    const trivialTombstone = makeSalvageEnergySource('tombstone-trivial', 1);
    const mineralOnlyRuin = makeSalvageEnergySource('ruin-mineral', 0, 100);
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES
        ) {
          return [];
        }

        if (type === FIND_TOMBSTONES) {
          return [emptyTombstone, trivialTombstone];
        }

        if (type === FIND_RUINS) {
          return [mineralOnlyRuin];
        }

        return type === FIND_SOURCES ? [source1, source2] : [];
      })
    } as unknown as Room;
    setGameCreeps({
      Assigned: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
        room
      } as unknown as Creep
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('ranks stored, salvage, and dropped energy by range-aware score', () => {
    const droppedEnergy = { id: 'drop-best', resourceType: 'energy', amount: 300 } as Resource<ResourceConstant>;
    const container = makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 75);
    const tombstone = makeSalvageEnergySource('tombstone-mid', 350);
    const ruin = makeSalvageEnergySource('ruin-far', 500);
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'container-near': 1,
        'drop-best': 2,
        'ruin-far': 8,
        'tombstone-mid': 4
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_RUINS) {
        return [ruin];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      if (type === FIND_TOMBSTONES) {
        return [tombstone];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-best' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('can prefer salvage over stored and dropped energy when salvage scores highest', () => {
    const droppedEnergy = { id: 'drop-far', resourceType: 'energy', amount: 500 } as Resource<ResourceConstant>;
    const container = makeStoredEnergyStructure('container-far', 'container' as StructureConstant, 400);
    const tombstone = makeSalvageEnergySource('tombstone-near', 260);
    const ruin = makeSalvageEnergySource('ruin-near', 100);
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'container-far': 8,
        'drop-far': 10,
        'ruin-near': 1,
        'tombstone-near': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      if (type === FIND_TOMBSTONES) {
        return [tombstone];
      }

      if (type === FIND_RUINS) {
        return [ruin];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'tombstone-near' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('uses stable amount and id fallback when range helpers are unavailable', () => {
    const droppedEnergy = { id: 'm-drop', resourceType: 'energy', amount: 100 } as Resource<ResourceConstant>;
    const container = makeStoredEnergyStructure('z-container', 'container' as StructureConstant, 100);
    const tombstone = makeSalvageEnergySource('a-tombstone', 100);
    const ruin = makeSalvageEnergySource('r-ruin', 100);
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      if (type === FIND_TOMBSTONES) {
        return [tombstone];
      }

      if (type === FIND_RUINS) {
        return [ruin];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'a-tombstone' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('does not drain spawn, extension, hostile, or enemy-room structures for energy', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(200),
        getFreeCapacity: jest.fn().mockReturnValue(100)
      }
    } as unknown as StructureSpawn;
    const extension = {
      id: 'extension1',
      structureType: 'extension',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(25),
        getFreeCapacity: jest.fn().mockReturnValue(25)
      }
    } as unknown as StructureExtension;
    const hostileStorage = makeStoredEnergyStructure('hostile-storage', 'storage' as StructureConstant, 1_000, {
      my: false
    });
    const unownedContainer = makeStoredEnergyStructure('unowned-container', 'container' as StructureConstant, 100);
    const source = { id: 'source1' } as Source;
    const room = {
      controller: { my: false, owner: { username: 'enemy' } },
      find: jest.fn((type: number) => {
        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        if (type === FIND_STRUCTURES) {
          return [spawn, extension, hostileStorage, unownedContainer];
        }

        return type === FIND_SOURCES ? [source] : [];
      })
    } as unknown as Room;
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('does not withdraw from containers in foreign-reserved or hostile rooms', () => {
    const source = { id: 'source1' } as Source;
    const hostileCreep = { id: 'hostile1' } as Creep;

    for (const room of [
      {
        controller: { my: false, reservation: { username: 'enemy' } },
        hostiles: []
      },
      {
        controller: { my: false },
        hostiles: [hostileCreep]
      }
    ]) {
      const container = makeStoredEnergyStructure('remote-container', 'container' as StructureConstant, 100);
      const roomFind = jest.fn((type: number) => {
        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        if (type === FIND_HOSTILE_CREEPS) {
          return room.hostiles;
        }

        if (type === FIND_STRUCTURES) {
          return [container];
        }

        return type === FIND_SOURCES ? [source] : [];
      });
      const creep = {
        owner: { username: 'me' },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(0),
          getFreeCapacity: jest.fn().mockReturnValue(50)
        },
        room: { controller: room.controller, find: roomFind }
      } as unknown as Creep;

      expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
    }
  });

  it('falls back to balanced harvesting when stored energy is unavailable', () => {
    const emptyContainer = makeStoredEnergyStructure('container-empty', 'container' as StructureConstant, 0);
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const room = {
      name: 'W1N1',
      controller: { my: true },
      find: jest.fn((type: number) => {
        if (type === FIND_DROPPED_RESOURCES) {
          return [];
        }

        if (type === FIND_STRUCTURES) {
          return [emptyContainer];
        }

        return type === FIND_SOURCES ? [source1, source2] : [];
      })
    } as unknown as Room;
    setGameCreeps({
      Assigned: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
        room
      } as unknown as Creep
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('ignores non-energy and below-threshold dropped resources before falling back to balanced harvesting', () => {
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const droppedMineral = { id: 'drop-mineral', resourceType: 'H' as ResourceConstant, amount: 100 } as Resource<ResourceConstant>;
    const zeroEnergy = { id: 'drop-zero', resourceType: 'energy', amount: 0 } as Resource<ResourceConstant>;
    const trivialEnergy = { id: 'drop-trivial', resourceType: 'energy', amount: 24 } as Resource<ResourceConstant>;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedMineral, zeroEnergy, trivialEnergy];
        }

        return type === FIND_SOURCES ? [source1, source2] : [];
      })
    } as unknown as Room;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        Assigned: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
          room
        } as unknown as Creep
      }
    };
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
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

  it('avoids depleted harvest sources when another source has energy', () => {
    const depletedSource = { id: 'source-empty', energy: 0 } as Source;
    const viableSource = { id: 'source-full', energy: 300 } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([depletedSource, viableSource])
    } as unknown as Room;
    setGameCreeps({
      Assigned: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: 'source-full' as Id<Source> } },
        room
      } as unknown as Creep
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-full' });
  });

  it('keeps room.find source order as the stable tie-breaker for viable sources', () => {
    const source2 = { id: 'source2', energy: 100 } as Source;
    const source1 = { id: 'source1', energy: 100 } as Source;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { name: 'W1N1', find: jest.fn().mockReturnValue([source2, source1]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('falls back deterministically when all sources are empty', () => {
    const source1 = { id: 'source1', energy: 0 } as Source;
    const source2 = { id: 'source2', energy: 0 } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([source1, source2])
    } as unknown as Room;
    setGameCreeps({
      Assigned: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
        room
      } as unknown as Creep
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('keeps room.find source order as the stable fallback when source energy is unknown', () => {
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
    ['extension', 'extension1'],
    ['tower', 'tower1']
  ])('selects transfer when worker has energy and %s needs energy', (structureType, id) => {
    const energySink = {
      id,
      structureType,
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as TestEnergySink;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn((type) => (type === 3 ? [energySink] : [])) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: id });
  });

  it('selects the closest spawn or extension before fillable towers', () => {
    const farSpawn = makeEnergySink('spawn-far', 'spawn' as StructureConstant, 300);
    const fullExtension = makeEnergySink('extension-full', 'extension' as StructureConstant, 0);
    const nearExtension = makeEnergySink('extension-near', 'extension' as StructureConstant, 50);
    const nearTower = makeEnergySink('tower-near', 'tower' as StructureConstant, 500);
    const structures = [farSpawn, fullExtension, nearTower, nearExtension];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'extension-full': 1,
        'extension-near': 2,
        'tower-near': 1,
        'spawn-far': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension-near' });
    expect(getRangeTo).not.toHaveBeenCalledWith(fullExtension);
    expect(getRangeTo).not.toHaveBeenCalledWith(nearTower);
  });

  it('selects the closest fillable spawn or extension', () => {
    const farSpawn = makeEnergySink('spawn-far', 'spawn' as StructureConstant, 300);
    const nearSpawn = makeEnergySink('spawn-near', 'spawn' as StructureConstant, 100);
    const closerExtension = makeEnergySink('extension-closer', 'extension' as StructureConstant, 50);
    const structures = [farSpawn, closerExtension, nearSpawn];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'extension-closer': 1,
        'spawn-far': 8,
        'spawn-near': 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension-closer' });
  });

  it('selects fillable extensions before fillable towers', () => {
    const farExtension = makeEnergySink('extension-far', 'extension' as StructureConstant, 50);
    const nearTower = makeEnergySink('tower-near', 'tower' as StructureConstant, 500);
    const structures = [nearTower, farExtension];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'tower-near': 1,
        'extension-far': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn((type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
          if (type !== FIND_MY_STRUCTURES) {
            return [];
          }

          return options?.filter ? structures.filter(options.filter) : structures;
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension-far' });
    expect(getRangeTo).not.toHaveBeenCalledWith(nearTower);
  });

  it('spends carried energy on construction instead of topping off a healthy tower after recovery', () => {
    const healthyTower = makeTowerEnergySink('tower-healthy', TOWER_REFILL_ENERGY_FLOOR, 500);
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        myStructures: [healthyTower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('spends carried energy on controller progress instead of topping off a healthy tower when no construction remains', () => {
    const healthyTower = makeTowerEnergySink('tower-healthy', TOWER_REFILL_ENERGY_FLOOR + 1, 499);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [healthyTower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps low tower refill before construction progress', () => {
    const lowTower = makeTowerEnergySink('tower-low', TOWER_REFILL_ENERGY_FLOOR - 1, 501);
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        myStructures: [lowTower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'tower-low' });
  });

  it.each([
    ['spawn', 'spawn-site1'],
    ['extension', 'extension-site1']
  ])('builds capacity-enabling %s construction before low tower refill', (structureType, id) => {
    const lowTower = makeTowerEnergySink('tower-low', TOWER_REFILL_ENERGY_FLOOR - 1, 501);
    const site = { id, structureType } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [lowTower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it('breaks same-class fillable energy sink range ties by id', () => {
    const laterSpawn = makeEnergySink('spawn-b', 'spawn' as StructureConstant, 300);
    const firstSpawn = makeEnergySink('spawn-a', 'spawn' as StructureConstant, 300);
    const structures = [laterSpawn, firstSpawn];
    const getRangeTo = jest.fn().mockReturnValue(4);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-a' });
  });

  it('keeps id order across primary energy sinks when position helpers are unavailable', () => {
    const extension = makeEnergySink('extension-first', 'extension' as StructureConstant, 50);
    const laterSpawn = makeEnergySink('spawn-z', 'spawn' as StructureConstant, 300);
    const firstSpawn = makeEnergySink('spawn-a', 'spawn' as StructureConstant, 300);
    const structures = [extension, laterSpawn, firstSpawn];
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension-first' });
  });

  it('preserves no-sink fallback behavior when all energy sinks are full', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const fullExtension = makeEnergySink('extension-full', 'extension' as StructureConstant, 0);
    const fullTower = makeEnergySink('tower-full', 'tower' as StructureConstant, 0);
    const site = { id: 'site1' } as ConstructionSite;
    const structures = [fullSpawn, fullExtension, fullTower];
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return type === FIND_CONSTRUCTION_SITES ? [site] : [];
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('reserves a safe visible territory target before spawn recovery resource collection', () => {
    const controller = { id: 'controller2', my: false } as StructureController;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = { id: 'drop1', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 100 }]
      }
    };
    const room = {
      name: 'W2N1',
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        return type === FIND_SOURCES ? [source] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(room.find).not.toHaveBeenCalledWith(FIND_MY_STRUCTURES, expect.anything());
    expect(room.find).not.toHaveBeenCalledWith(FIND_DROPPED_RESOURCES);
    expect(room.find).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('keeps a visible reserve target before spawn refill under concurrent energy pressure', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = { id: 'controller2', my: false } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(spawn.store.getFreeCapacity).not.toHaveBeenCalled();
  });

  it('renews an urgent own visible reservation before local construction with enough CLAIM parts', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 106 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('renews a normal-threshold own visible reservation before local construction with one CLAIM part', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 106 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('renews an emergency own visible reservation before local construction with one CLAIM part', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 106 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('keeps local construction before an above-normal own reservation renewal with one CLAIM part', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 106 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('keeps local construction before a comfortable own visible reservation', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 107 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('continues a visible own reservation above the normal renewal threshold with enough CLAIM parts', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 107 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('stops continuing a visible own reservation once it is comfortably safe', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_COMFORT_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 107 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('claims a safe visible territory target before local construction', () => {
    const controller = { id: 'controller2', my: false } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 101 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'claim', targetId: 'controller2' });
  });

  it('upgrades a claimed territory target before unrelated construction support', () => {
    const controller = { id: 'controller2', my: true, level: 1 } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 102 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller2' });
  });

  it('does not prioritize a freshly suppressed urgent reservation renewal', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'suppressed', updatedAt: 103 }]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 104 };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('does not continue a freshly suppressed reservation inside the comfort buffer', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'suppressed', updatedAt: 103 }]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 104 };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('does not prioritize an unsafe urgent reservation renewal', () => {
    const hostile = { id: 'hostile1' } as Creep;
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 108 }]
      }
    };
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller });
    const baseFind = room.find.bind(room) as (
      type: number,
      options?: { filter?: (structure: AnyOwnedStructure) => boolean }
    ) => unknown[];
    room.find = jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return [hostile];
      }

      return baseFind(type, options);
    }) as unknown as Room['find'];
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('does not continue a reservation inside the comfort buffer in an unsafe room', () => {
    const hostile = { id: 'hostile1' } as Creep;
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 108 }]
      }
    };
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller });
    const baseFind = room.find.bind(room) as (
      type: number,
      options?: { filter?: (structure: AnyOwnedStructure) => boolean }
    ) => unknown[];
    room.find = jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return [hostile];
      }

      return baseFind(type, options);
    }) as unknown as Room['find'];
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('keeps spawn refill before claimed territory upgrade support', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = { id: 'controller2', my: true, level: 2 } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 105 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

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

  it.each([
    ['road', 5_000],
    ['container', 2_000]
  ])('repairs critical %s damage before generic construction', (structureType, hitsMax) => {
    const site = { id: 'generic-site1', structureType: 'tower' } as ConstructionSite;
    const repairTarget = makeStructure(
      `${structureType}-critical`,
      structureType as StructureConstant,
      Math.floor(hitsMax * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO),
      hitsMax
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], structures: [repairTarget] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: `${structureType}-critical` });
  });

  it.each([
    ['road', 5_000],
    ['container', 2_000]
  ])('repairs critical %s damage before matching construction', (structureType, hitsMax) => {
    const site = { id: `${structureType}-site1`, structureType } as ConstructionSite;
    const repairTarget = makeStructure(
      `${structureType}-critical`,
      structureType as StructureConstant,
      Math.floor(hitsMax * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO),
      hitsMax
    );
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [repairTarget] });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: `${structureType}-critical` });
  });

  it('keeps non-critical road and container repair behind generic construction', () => {
    const site = { id: 'generic-site1', structureType: 'tower' } as ConstructionSite;
    const road = makeStructure(
      'road-non-critical',
      'road' as StructureConstant,
      Math.floor(5_000 * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO) + 1,
      5_000
    );
    const container = makeStructure(
      'container-non-critical',
      'container' as StructureConstant,
      Math.floor(2_000 * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO) + 1,
      2_000
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], structures: [road, container] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'generic-site1' });
  });

  it.each([
    ['spawn', 'spawn1'],
    ['extension', 'extension1'],
    ['tower', 'tower1']
  ])('keeps %s refill before critical road repair', (structureType, id) => {
    const energySink = makeEnergySink(id, structureType as StructureConstant, 300);
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        myStructures: [energySink as AnyOwnedStructure],
        structures: [road]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: id });
  });

  it('keeps controller downgrade guard before critical road repair', () => {
    const site = { id: 'generic-site1', structureType: 'road' } as ConstructionSite;
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [road] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps controller downgrade guard before tower refill', () => {
    const tower = makeEnergySink('tower1', 'tower' as StructureConstant, 500);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [tower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it.each([
    ['spawn', 'spawn-site1'],
    ['extension', 'extension-site1']
  ])('keeps %s construction before critical container repair', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
    const container = makeStructure('container-critical', 'container' as StructureConstant, 400, 2_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [container] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it('keeps RCL1 controller rush before critical road repair', () => {
    const site = { id: 'generic-site1', structureType: 'road' } as ConstructionSite;
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [road] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps critical road repair before sustained controller progress', () => {
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller, structures: [road] });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-critical' });
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
  ])('builds %s construction before sustained controller progress when another loaded worker can build', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it.each([
    ['spawn', 'spawn-site1'],
    ['extension', 'extension-site1']
  ])('builds RCL2 critical %s construction before road construction and controller progress guard', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [roadSite, site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Worker2: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it.each([
    ['road', 'road-site1'],
    ['container', 'container-site1']
  ])('builds extension construction before %s construction', (structureType, id) => {
    const roadOrContainerSite = { id, structureType } as ConstructionSite;
    const extensionSite = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [roadOrContainerSite, extensionSite],
      controller
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('builds container construction before road construction after spawn refill is satisfied', () => {
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 0);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite, containerSite],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'container-site1' });
  });

  it('builds the closest same-priority construction site after spawn refill is satisfied', () => {
    const farRoadSite = { id: 'road-far', structureType: 'road' } as ConstructionSite;
    const nearRoadSite = { id: 'road-near', structureType: 'road' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 0);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: ConstructionSite) => {
      const ranges: Record<string, number> = {
        'road-far': 9,
        'road-near': 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        constructionSites: [farRoadSite, nearRoadSite],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-near' });
  });

  it('breaks same-priority construction site range ties by id', () => {
    const secondRoadSite = { id: 'road-b', structureType: 'road' } as ConstructionSite;
    const firstRoadSite = { id: 'road-a', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn().mockReturnValue(4) },
      room: makeWorkerTaskRoom({
        constructionSites: [secondRoadSite, firstRoadSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-a' });
  });

  it('keeps spawn refill before container-first construction throughput', () => {
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite, containerSite],
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('guards critically low spawn energy from construction spending', () => {
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 101);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite, containerSite],
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps construction spending when spawn refill is no longer urgent', () => {
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 100);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite, containerSite],
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'container-site1' });
  });

  it('keeps controller progress when spawn refill is no longer urgent and no construction remains', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 100);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
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

  it('keeps RCL3 build-before-upgrade priority when only one loaded worker is available', () => {
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

  it('routes carried energy to controller upgrade before non-critical construction once spawn recovery is safe', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('uses nearby non-critical construction before controller pressure upgrade after urgent refill', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'tower-site1': 2,
        controller1: 7
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-site1' });
  });

  it('keeps controller pressure upgrade when non-critical construction is farther than the controller', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'tower-site1': 9,
        controller1: 3
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it.each([
    ['missing', { role: 'worker' }],
    ['empty', { role: 'worker', colony: '' }]
  ])('ignores territory pressure when worker colony memory is %s', (_caseName, memory) => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const creep = {
      memory,
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-site1' });
  });

  it('routes carried energy to controller upgrade before non-critical construction when stored surplus exists', () => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [storage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('routes carried energy to controller upgrade before non-critical construction when salvage surplus exists', () => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const tombstone = makeSalvageEnergySource('tombstone-surplus', 100);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => {
        if (
          type === FIND_MY_STRUCTURES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        return type === FIND_TOMBSTONES ? [tombstone] : [];
      })
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(room.find).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('uses nearby non-critical repair before stored-surplus controller upgrading', () => {
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const road = makeStructure('road-damaged', 'road' as StructureConstant, 4_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'road-damaged': 2,
        controller1: 8
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({ controller, structures: [storage, road] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-damaged' });
  });

  it('keeps controller upgrade when a nearby repair target is already complete', () => {
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const fullRoad = makeStructure('road-full', 'road' as StructureConstant, 5_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'road-full': 1,
        controller1: 8
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({ controller, structures: [storage, fullRoad] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps extension construction before stored-surplus controller upgrading', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [storage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('keeps critical repair before stored-surplus controller upgrading', () => {
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ controller, structures: [storage, road] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-critical' });
  });

  it('keeps road construction before stored-surplus controller upgrading', () => {
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [storage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-site1' });
  });

  it('does not treat unsafe stored energy as controller upgrade surplus', () => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const hostileStorage = makeStoredEnergyStructure('hostile-storage', 'storage' as StructureConstant, 1_000, {
      my: false
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [hostileStorage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-site1' });
  });

  it('selects RCL3 controller upgrade before non-critical construction when another loaded worker can build', () => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps non-critical build priority when another loaded worker is already upgrading the controller', () => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({
      Upgrader: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> })
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-site1' });
  });

  it.each([
    ['road', 'road-site1'],
    ['container', 'container-site1']
  ])('keeps low-downgrade guard above %s construction at RCL2', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
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

  it('keeps spawn refill priority over the controller pressure lane', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        name: 'W1N1',
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === FIND_CONSTRUCTION_SITES ? [site] : [];
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

  it('selects damaged road repair before idle controller upgrading', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const fullRoad = makeStructure('road-full', 'road' as StructureConstant, 5_000, 5_000);
    const damagedRoad = makeStructure('road-damaged', 'road' as StructureConstant, 3_000, 5_000);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [fullRoad, damagedRoad] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-damaged' });
  });

  it('chooses repair targets deterministically and avoids hostile structures', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const hostileRampart = makeStructure('rampart-hostile', 'rampart' as StructureConstant, 100, 1_000, {
      my: false
    });
    const damagedContainer = makeStructure('container-damaged', 'container' as StructureConstant, 100, 2_000);
    const roadB = makeStructure('road-b', 'road' as StructureConstant, 2_500, 5_000);
    const roadA = makeStructure('road-a', 'road' as StructureConstant, 2_500, 5_000);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [hostileRampart, damagedContainer, roadB, roadA] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-a' });
  });

  it('selects owned ramparts below the idle repair ceiling', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const rampart = makeStructure(
      'rampart-low',
      'rampart' as StructureConstant,
      IDLE_RAMPART_REPAIR_HITS_CEILING - 1,
      300_000_000,
      { my: true }
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [rampart] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'rampart-low' });
  });

  it('skips owned ramparts at the idle repair ceiling without blocking container repair', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const rampart = makeStructure(
      'rampart-ceiling',
      'rampart' as StructureConstant,
      IDLE_RAMPART_REPAIR_HITS_CEILING,
      300_000_000,
      { my: true }
    );
    const container = makeStructure('container-damaged', 'container' as StructureConstant, 1_000, 2_000);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [rampart, container] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'container-damaged' });
  });

  it('falls back to upgrade when only owned ramparts above the idle repair ceiling are damaged', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const rampart = makeStructure(
      'rampart-high',
      'rampart' as StructureConstant,
      IDLE_RAMPART_REPAIR_HITS_CEILING + 1,
      300_000_000,
      { my: true }
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [rampart] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('falls back to upgrade when no safe damaged repair targets exist', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const fullRoad = makeStructure('road-full', 'road' as StructureConstant, 5_000, 5_000);
    const hostileRampart = makeStructure('rampart-hostile', 'rampart' as StructureConstant, 100, 1_000, {
      my: false
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [fullRoad, hostileRampart] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps carried-energy fallback order as transfer, build, repair, then upgrade', () => {
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
    const road = makeStructure('road-damaged', 'road' as StructureConstant, 3_000, 5_000);
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
    const roomWithRepair = {
      controller,
      find: jest.fn((type: number) => (type === FIND_STRUCTURES ? [road] : []))
    } as unknown as Room;
    const roomWithController = {
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;

    expect(selectWorkerTask(makeCreep(roomWithSink))).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(selectWorkerTask(makeCreep(roomWithSite))).toEqual({ type: 'build', targetId: 'site1' });
    expect(selectWorkerTask(makeCreep(roomWithRepair))).toEqual({ type: 'repair', targetId: 'road-damaged' });
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
