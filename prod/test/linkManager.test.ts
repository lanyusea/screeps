import { classifyLinks, distributeEnergy, transferEnergy } from '../src/economy/linkManager';

const OK_CODE = 0 as ScreepsReturnCode;
type TestStructureLink = StructureLink & { transferEnergy: jest.Mock };

describe('linkManager', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_STRUCTURES: 1,
      FIND_SOURCES: 2,
      FIND_MY_CREEPS: 3,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_EXTENSION: 'extension',
      STRUCTURE_LINK: 'link',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_STORAGE: 'storage',
      STRUCTURE_TOWER: 'tower'
    });
  });

  afterEach(() => {
    delete (globalThis as unknown as { Memory?: { rooms?: Record<string, RoomMemory> } }).Memory;
  });

  it('handles rooms with no links', () => {
    const room = makeRoom({ sources: [makeSource('source1', 10, 10)] });

    expect(transferEnergy(room)).toEqual([]);
  });

  it('initializes missing room memory through global Memory.rooms', () => {
    const runtime = globalThis as unknown as { Memory?: { rooms?: Record<string, RoomMemory> } };
    runtime.Memory = { rooms: {} };
    const room = makeRoom({ sources: [makeSource('source1', 10, 10)] });
    Object.defineProperty(room, 'memory', {
      configurable: true,
      get: () => runtime.Memory?.rooms?.[room.name]
    });

    const result = distributeEnergy(room, 100, []);

    expect(result.nextCheckAt).toBe(105);
    expect(runtime.Memory.rooms?.W1N1.linkDistribution).toMatchObject({
      lastCheckedAt: 100,
      nextCheckAt: 105
    });
  });

  it('classifies source, controller, and storage links by room-local positions', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 800);
    const storageLink = makeLink('storage-link', 20, 21, 0, 800);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [storageLink, controllerLink, sourceLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage('storage1', 20, 20, 5_000)
    });

    expect(classifyLinks(room)).toMatchObject({
      sourceLinks: [{ id: 'source-link' }],
      controllerLink: { id: 'controller-link' },
      storageLink: { id: 'storage-link' }
    });
  });

  it('transfers source link energy to the controller link first', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 300);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)]
    });

    expect(transferEnergy(room)).toEqual([
      {
        amount: 300,
        destinationId: 'controller-link',
        destinationRole: 'controller',
        result: OK_CODE,
        sourceId: 'source-link'
      }
    ]);
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(controllerLink, 300);
  });

  it('falls back to the storage link when the controller link is full', () => {
    const sourceLink = makeLink('source-link', 11, 10, 250, 550);
    const controllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const storageLink = makeLink('storage-link', 20, 21, 0, 200);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage('storage1', 20, 20, 5_000)
    });

    expect(transferEnergy(room)).toMatchObject([
      {
        amount: 200,
        destinationId: 'storage-link',
        destinationRole: 'storage',
        sourceId: 'source-link'
      }
    ]);
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(storageLink, 200);
  });

  it('respects source cooldown and empty or full link edge cases', () => {
    const coolingSourceLink = makeLink('cooling-source', 11, 10, 400, 400, 3);
    const emptySourceLink = makeLink('empty-source', 11, 12, 0, 800);
    const fullControllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [coolingSourceLink, emptySourceLink, fullControllerLink],
      sources: [makeSource('source1', 10, 10)]
    });

    expect(transferEnergy(room)).toEqual([]);
    expect(coolingSourceLink.transferEnergy).not.toHaveBeenCalled();
    expect(emptySourceLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('tracks projected destination capacity across multiple source links', () => {
    const sourceLinkA = makeLink('source-a', 11, 10, 400, 400);
    const sourceLinkB = makeLink('source-b', 13, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 500);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLinkB, controllerLink, sourceLinkA],
      sources: [makeSource('source1', 10, 10), makeSource('source2', 14, 10)]
    });

    expect(transferEnergy(room)).toMatchObject([
      { amount: 400, sourceId: 'source-a', destinationId: 'controller-link' },
      { amount: 100, sourceId: 'source-b', destinationId: 'controller-link' }
    ]);
    expect(sourceLinkA.transferEnergy).toHaveBeenCalledWith(controllerLink, 400);
    expect(sourceLinkB.transferEnergy).toHaveBeenCalledWith(controllerLink, 100);
  });

  it('keeps source-link energy available for spawn refill before controller upgrade transfer', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 400);
    const spawn = makeSpawn('spawn1', 100, 200);
    const worker = makeWorker('Worker1', 0, 50);
    const room = makeRoom({
      controller: makeController(25, 25),
      creeps: [worker],
      energyAvailable: 100,
      energyCapacityAvailable: 300,
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)],
      structures: [sourceLink, controllerLink, spawn]
    });
    const events: Parameters<typeof distributeEnergy>[2] = [];

    const result = distributeEnergy(room, 100, events);

    expect(result.transfers).toEqual([]);
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
    expect(worker.memory.task).toEqual({ type: 'withdraw', targetId: 'source-link' });
    expect(result.actions).toEqual([
      {
        action: 'workerWithdraw',
        amount: 50,
        path: 'source->spawnExtension',
        sourceId: 'source-link',
        workerName: 'Worker1'
      }
    ]);
    expect(events).toMatchObject([
      {
        type: 'linkDistribution',
        roomName: 'W1N1',
        action: 'workerWithdraw',
        amount: 50,
        path: 'source->spawnExtension',
        sourceId: 'source-link',
        workerName: 'Worker1'
      }
    ]);
  });

  it('keeps source-link energy available for tower refill before controller upgrade transfer', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 400);
    const tower = makeTower('tower1', 100, 900);
    const worker = makeWorker('Worker1', 0, 50);
    const room = makeRoom({
      controller: makeController(25, 25),
      creeps: [worker],
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)],
      structures: [sourceLink, controllerLink, tower]
    });

    const result = distributeEnergy(room, 100, []);

    expect(result.transfers).toEqual([]);
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
    expect(worker.memory.task).toEqual({ type: 'withdraw', targetId: 'source-link' });
    expect(result.actions).toEqual([
      {
        action: 'workerWithdraw',
        amount: 50,
        path: 'source->tower',
        sourceId: 'source-link',
        workerName: 'Worker1'
      }
    ]);
  });

  it('does not overwrite existing non-link worker tasks while preserving source-link refill priority', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 400);
    const spawn = makeSpawn('spawn1', 100, 200);
    const worker = makeWorker('Builder1', 0, 50, {
      task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> }
    });
    const room = makeRoom({
      controller: makeController(25, 25),
      creeps: [worker],
      energyAvailable: 100,
      energyCapacityAvailable: 300,
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)],
      structures: [sourceLink, controllerLink, spawn]
    });

    const result = distributeEnergy(room, 110, []);

    expect(result.assignedTasks).toBe(0);
    expect(result.transfers).toEqual([]);
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
    expect(worker.memory.task).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('routes source-link energy through a controller link and assigns upgrade withdrawal', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 300);
    const worker = makeWorker('Upgrader1', 0, 50, {
      task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
    });
    const room = makeRoom({
      controller: makeController(25, 25),
      creeps: [worker],
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)]
    });
    const events: Parameters<typeof distributeEnergy>[2] = [];

    const result = distributeEnergy(room, 101, events);

    expect(result.transfers).toMatchObject([
      {
        amount: 300,
        destinationId: 'controller-link',
        destinationRole: 'controller',
        result: OK_CODE,
        sourceId: 'source-link'
      }
    ]);
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(controllerLink, 300);
    expect(worker.memory.task).toEqual({ type: 'withdraw', targetId: 'controller-link' });
    expect(result.actions).toEqual([
      {
        action: 'linkTransfer',
        amount: 300,
        destinationId: 'controller-link',
        path: 'source->controllerLink',
        result: OK_CODE,
        sourceId: 'source-link'
      },
      {
        action: 'workerWithdraw',
        amount: 50,
        path: 'controllerLink->upgrade',
        sourceId: 'controller-link',
        workerName: 'Upgrader1'
      }
    ]);
  });

  it('does not retry source-link transfers while cooldown scheduling is active', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400, 3);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 300);
    const room = makeRoom({
      controller: makeController(25, 25),
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)]
    });
    const events: Parameters<typeof distributeEnergy>[2] = [];

    const firstResult = distributeEnergy(room, 200, events);
    const secondResult = distributeEnergy(room, 201, events);

    expect(firstResult.transfers).toEqual([]);
    expect(firstResult.nextCheckAt).toBe(203);
    expect(firstResult.actions).toEqual([
      {
        action: 'cooldown',
        cooldownTicks: 3,
        path: 'source->controllerLink'
      }
    ]);
    expect(secondResult).toEqual({ actions: [], assignedTasks: 0, nextCheckAt: 203, transfers: [] });
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('wakes a sleeping scheduler when a tower needs refill energy', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const tower = makeTower('tower1', 100, 900);
    const worker = makeWorker('Worker1', 0, 50);
    const room = makeRoom({
      creeps: [worker],
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      links: [sourceLink],
      sources: [makeSource('source1', 10, 10)],
      structures: [sourceLink, tower]
    });
    room.memory.linkDistribution = { nextCheckAt: 205 };

    const result = distributeEnergy(room, 201, []);

    expect(worker.memory.task).toEqual({ type: 'withdraw', targetId: 'source-link' });
    expect(result.actions).toEqual([
      {
        action: 'workerWithdraw',
        amount: 50,
        path: 'source->tower',
        sourceId: 'source-link',
        workerName: 'Worker1'
      }
    ]);
    expect(result.nextCheckAt).toBe(202);
  });

  it('routes storage fallback into the storage link before assigning worker hauling', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const storageLink = makeLink('storage-link', 20, 21, 0, 800);
    const storage = makeStorage('storage1', 20, 20, 5_000, 1_000);
    const loadedWorker = makeWorker('Loaded', 50, 0);
    const room = makeRoom({
      creeps: [loadedWorker],
      links: [sourceLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage,
      structures: [sourceLink, storageLink, storage]
    });

    const result = distributeEnergy(room, 300, []);

    expect(result.transfers).toMatchObject([
      {
        amount: 400,
        destinationId: 'storage-link',
        destinationRole: 'storage',
        result: OK_CODE,
        sourceId: 'source-link'
      }
    ]);
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(storageLink, 400);
    expect(loadedWorker.memory.task).toBeUndefined();
    expect(result.actions).toEqual([
      {
        action: 'linkTransfer',
        amount: 400,
        destinationId: 'storage-link',
        path: 'source->storage',
        result: OK_CODE,
        sourceId: 'source-link'
      }
    ]);
  });

  it('falls back to worker storage hauling when the storage link is full', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const storageLink = makeLink('storage-link', 20, 21, 800, 0);
    const storage = makeStorage('storage1', 20, 20, 5_000, 1_000);
    const loadedWorker = makeWorker('Loaded', 50, 0);
    const room = makeRoom({
      creeps: [loadedWorker],
      links: [sourceLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage,
      structures: [sourceLink, storageLink, storage]
    });

    const result = distributeEnergy(room, 300, []);

    expect(result.transfers).toEqual([]);
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
    expect(loadedWorker.memory.task).toEqual({ type: 'transfer', targetId: 'storage1' });
    expect(result.actions).toEqual([
      {
        action: 'workerTransfer',
        amount: 50,
        destinationId: 'storage1',
        path: 'source->storage',
        workerName: 'Loaded'
      }
    ]);
  });

  it('uses storage fallback only after spawn, tower, and controller-link priorities are unavailable', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const storage = makeStorage('storage1', 20, 20, 5_000, 1_000);
    const loadedWorker = makeWorker('Loaded', 50, 0);
    const room = makeRoom({
      controller: makeController(25, 25),
      creeps: [loadedWorker],
      links: [sourceLink],
      sources: [makeSource('source1', 10, 10)],
      storage,
      structures: [sourceLink, storage]
    });

    const result = distributeEnergy(room, 300, []);

    expect(result.transfers).toEqual([]);
    expect(loadedWorker.memory.task).toEqual({ type: 'transfer', targetId: 'storage1' });
    expect(result.actions).toEqual([
      {
        action: 'workerTransfer',
        amount: 50,
        destinationId: 'storage1',
        path: 'source->storage',
        workerName: 'Loaded'
      }
    ]);
  });
});

function makeRoom({
  controller = makeController(25, 25),
  creeps = [],
  energyAvailable,
  energyCapacityAvailable,
  links = [],
  sources = [],
  storage,
  structures
}: {
  controller?: StructureController;
  creeps?: Creep[];
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  links?: TestStructureLink[];
  sources?: Source[];
  storage?: StructureStorage;
  structures?: AnyOwnedStructure[];
}): Room {
  const ownedStructures = structures ?? (storage ? [...links, storage] : links);
  return {
    name: 'W1N1',
    controller,
    memory: {},
    ...(energyAvailable === undefined ? {} : { energyAvailable }),
    ...(energyCapacityAvailable === undefined ? {} : { energyCapacityAvailable }),
    ...(storage ? { storage } : {}),
    find: jest.fn((type: number) => {
      if (type === FIND_MY_STRUCTURES) {
        return ownedStructures;
      }

      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_MY_CREEPS) {
        return creeps;
      }

      return [];
    })
  } as unknown as Room;
}

function makeLink(
  id: string,
  x: number,
  y: number,
  energy: number,
  freeCapacity: number,
  cooldown = 0
): TestStructureLink {
  return {
    id,
    cooldown,
    structureType: 'link',
    pos: makeRoomPosition(x, y),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    },
    transferEnergy: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as TestStructureLink;
}

function makeStorage(id: string, x: number, y: number, energy: number, freeCapacity = 0): StructureStorage {
  return {
    id,
    structureType: 'storage',
    pos: makeRoomPosition(x, y),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    }
  } as unknown as StructureStorage;
}

function makeSpawn(id: string, energy: number, freeCapacity: number): StructureSpawn {
  return {
    id,
    structureType: 'spawn',
    pos: makeRoomPosition(20, 20),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    }
  } as unknown as StructureSpawn;
}

function makeTower(id: string, energy: number, freeCapacity: number): StructureTower {
  return {
    id,
    structureType: 'tower',
    pos: makeRoomPosition(20, 20),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    }
  } as unknown as StructureTower;
}

function makeWorker(
  name: string,
  carriedEnergy: number,
  freeCapacity: number,
  memory: Partial<CreepMemory> = {}
): Creep {
  return {
    name,
    memory: { role: 'worker', colony: 'W1N1', ...memory },
    pos: { getRangeTo: jest.fn().mockReturnValue(1) },
    room: { name: 'W1N1' } as Room,
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(carriedEnergy)
    }
  } as unknown as Creep;
}

function makeSource(id: string, x: number, y: number): Source {
  return { id, pos: makeRoomPosition(x, y) } as unknown as Source;
}

function makeController(x: number, y: number): StructureController {
  return { id: 'controller1', my: true, pos: makeRoomPosition(x, y) } as unknown as StructureController;
}

function makeRoomPosition(x: number, y: number): RoomPosition {
  return { x, y, roomName: 'W1N1' } as RoomPosition;
}
