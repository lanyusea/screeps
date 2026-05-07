import {
  selectEnergyDropoffOptimizationTask
} from '../src/creeps/energyDropoffOptimizer';
import { runWorker } from '../src/creeps/workerRunner';

function makePosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function makeStorage(id = 'storage1', x = 10, y = 10): StructureStorage {
  return {
    id,
    structureType: 'storage',
    pos: makePosition(x, y),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(1_000)
    }
  } as unknown as StructureStorage;
}

function makeConstructionSite(id = 'site1', x = 4, y = 4): ConstructionSite {
  return {
    id,
    my: true,
    pos: makePosition(x, y),
    progress: 10,
    progressTotal: 100,
    structureType: 'road'
  } as unknown as ConstructionSite;
}

function makeController(level = 3, x = 4, y = 4): StructureController {
  return {
    id: 'controller1',
    my: true,
    level,
    pos: makePosition(x, y),
    progress: 100,
    progressTotal: 1_000
  } as unknown as StructureController;
}

function makeRefillStructure(
  id: string,
  structureType: StructureConstant,
  x = 4,
  y = 4
): StructureSpawn | StructureTower {
  return {
    id,
    structureType,
    pos: makePosition(x, y),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(100)
    }
  } as unknown as StructureSpawn | StructureTower;
}

function makeRoom({
  constructionSites = [],
  controller = makeController(8),
  myStructures = []
}: {
  constructionSites?: ConstructionSite[];
  controller?: StructureController;
  myStructures?: AnyOwnedStructure[];
} = {}): Room {
  return {
    name: 'W1N1',
    controller,
    find: jest.fn((type: number) => {
      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      if (type === FIND_MY_STRUCTURES) {
        return myStructures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeCreep(room: Room, x = 1, y = 1): Creep {
  return {
    name: 'Worker1',
    memory: { role: 'worker', colony: 'W1N1' },
    pos: makePosition(x, y),
    room,
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(50),
      getFreeCapacity: jest.fn().mockReturnValue(0)
    }
  } as unknown as Creep;
}

describe('energy dropoff optimizer', () => {
  beforeEach(() => {
    (globalThis as unknown as { ERR_NOT_IN_RANGE: number }).ERR_NOT_IN_RANGE = -9;
    (globalThis as unknown as { ERR_FULL: number }).ERR_FULL = -8;
    (globalThis as unknown as { ERR_NOT_ENOUGH_RESOURCES: number }).ERR_NOT_ENOUGH_RESOURCES = -6;
    (globalThis as unknown as { ERR_INVALID_TARGET: number }).ERR_INVALID_TARGET = -7;
    (globalThis as unknown as { OK: number }).OK = 0;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { FIND_DROPPED_RESOURCES: number }).FIND_DROPPED_RESOURCES = 4;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 8;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_ROAD: StructureConstant }).STRUCTURE_ROAD = 'road';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_LINK: StructureConstant }).STRUCTURE_LINK = 'link';
    (globalThis as unknown as { STRUCTURE_RAMPART: StructureConstant }).STRUCTURE_RAMPART = 'rampart';
    (globalThis as unknown as { CLAIM: BodyPartConstant }).CLAIM = 'claim';
    (globalThis as unknown as { WORK: BodyPartConstant }).WORK = 'work';
    delete (globalThis as unknown as { PathFinder?: Partial<PathFinder> }).PathFinder;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {} };
  });

  it('selects a construction site on the storage return path', () => {
    const storage = makeStorage();
    const site = makeConstructionSite();
    const room = makeRoom({
      constructionSites: [site],
      myStructures: [storage as unknown as AnyOwnedStructure]
    });
    const creep = makeCreep(room);

    expect(selectEnergyDropoffOptimizationTask(creep, storage)).toEqual({
      type: 'build',
      targetId: 'site1'
    });
  });

  it('selects controller upgrade when the controller can still level up', () => {
    const storage = makeStorage();
    const controller = makeController(4);
    const room = makeRoom({ controller });
    const creep = makeCreep(room);

    expect(selectEnergyDropoffOptimizationTask(creep, storage)).toEqual({
      type: 'upgrade',
      targetId: 'controller1'
    });
  });

  it.each([
    ['spawn', 'spawn1' as const],
    ['tower', 'tower1' as const]
  ])('selects a nearby %s refill before storage dropoff', (structureType, targetId) => {
    const storage = makeStorage();
    const refillTarget = makeRefillStructure(targetId, structureType as StructureConstant);
    const room = makeRoom({
      myStructures: [refillTarget as AnyOwnedStructure]
    });
    const creep = makeCreep(room);

    expect(selectEnergyDropoffOptimizationTask(creep, storage)).toEqual({
      type: 'transfer',
      targetId
    });
  });

  it('falls back to storage when no better target is near the return path', () => {
    const storage = makeStorage('storage1', 3, 3);
    const farSite = makeConstructionSite('site1', 12, 12);
    const room = makeRoom({
      constructionSites: [farSite],
      controller: makeController(8, 4, 4)
    });
    const creep = makeCreep(room);

    expect(selectEnergyDropoffOptimizationTask(creep, storage)).toBeNull();
  });

  it('redirects an assigned storage transfer to the optimized dropoff target in the worker runner', () => {
    const storage = makeStorage();
    const site = makeConstructionSite();
    const room = makeRoom({
      constructionSites: [site],
      myStructures: [storage as unknown as AnyOwnedStructure]
    });
    const creep = {
      ...makeCreep(room),
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'transfer', targetId: 'storage1' as Id<AnyStoreStructure> }
      },
      build: jest.fn().mockReturnValue(0),
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'storage1' ? storage : site))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.build).toHaveBeenCalledWith(site);
    expect(creep.transfer).not.toHaveBeenCalled();
  });
});
