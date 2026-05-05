import {
  manageStorage,
  TOWER_REFILL_THRESHOLD
} from '../src/economy/storageManager';

const OK_CODE = 0 as ScreepsReturnCode;
type TestStructureLink = StructureLink & { transfer: jest.Mock };

describe('storageManager', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_CREEPS: 1,
      FIND_MY_STRUCTURES: 2,
      FIND_SOURCES: 3,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_EXTENSION: 'extension',
      STRUCTURE_LINK: 'link',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_STORAGE: 'storage',
      STRUCTURE_TOWER: 'tower'
    });
  });

  it('handles rooms without storage', () => {
    const worker = makeWorker('Worker1', 0, 50);
    const room = makeRoom({ creeps: [worker], structures: [makeTower('tower1', 100, 900)] });

    expect(manageStorage(room)).toEqual({ assignedTasks: 0, linkTransfers: [] });
    expect(worker.memory.task).toBeUndefined();
  });

  it('assigns tower refill delivery and storage withdrawal when tower energy is low', () => {
    const storage = makeStorage(2_000);
    const tower = makeTower('tower1', TOWER_REFILL_THRESHOLD - 1, 501);
    const loadedWorker = makeWorker('Loaded', 50, 0);
    const emptyWorker = makeWorker('Empty', 0, 50);
    const room = makeRoom({
      creeps: [emptyWorker, loadedWorker],
      storage,
      structures: [storage, tower]
    });

    expect(manageStorage(room).assignedTasks).toBe(2);
    expect(loadedWorker.memory.task).toEqual({ type: 'transfer', targetId: 'tower1' });
    expect(emptyWorker.memory.task).toEqual({ type: 'withdraw', targetId: 'storage1' });
  });

  it('keeps storage above the room energy buffer before assigning withdrawals', () => {
    const storage = makeStorage(520);
    const spawn = makeSpawn('spawn1', 200);
    const worker = makeWorker('Worker1', 0, 50);
    const room = makeRoom({
      creeps: [worker],
      energyAvailable: 100,
      energyCapacityAvailable: 300,
      storage,
      structures: [storage, spawn]
    });

    expect(manageStorage(room).assignedTasks).toBe(0);
    expect(worker.memory.task).toBeUndefined();
  });

  it('distributes storage energy to spawn and extensions when room energy is low', () => {
    const storage = makeStorage(2_000);
    const spawn = makeSpawn('spawn1', 200);
    const extension = makeExtension('extension1', 50);
    const worker = makeWorker('Worker1', 50, 0, {
      getRangeTo: jest.fn((target: RoomObject) =>
        (target as { id?: string }).id === 'extension1' ? 1 : 5
      )
    });
    const room = makeRoom({
      creeps: [worker],
      energyAvailable: 100,
      energyCapacityAvailable: 350,
      storage,
      structures: [storage, spawn, extension]
    });

    manageStorage(room);

    expect(worker.memory.task).toEqual({ type: 'transfer', targetId: 'extension1' });
  });

  it('feeds controller links from storage links when possible', () => {
    const storage = makeStorage(0);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 300);
    const storageLink = makeLink('storage-link', 20, 21, 400, 400);
    const room = makeRoom({
      controller: makeController(25, 25),
      storage,
      structures: [storage, controllerLink, storageLink],
      sources: [makeSource('source1', 10, 10)]
    });

    expect(manageStorage(room).linkTransfers).toEqual([
      {
        amount: 300,
        destinationId: 'controller-link',
        result: OK_CODE,
        sourceId: 'storage-link'
      }
    ]);
    expect(storageLink.transfer).toHaveBeenCalledWith(controllerLink, 300);
  });

  it('does not feed controller links when the storage link is cooling down or the destination is full', () => {
    const storage = makeStorage(2_000);
    const controllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const storageLink = makeLink('storage-link', 20, 21, 400, 400, 2);
    const room = makeRoom({
      controller: makeController(25, 25),
      storage,
      structures: [storage, controllerLink, storageLink]
    });

    expect(manageStorage(room).linkTransfers).toEqual([]);
    expect(storageLink.transfer).not.toHaveBeenCalled();
  });

  it('assigns workers to fill the storage link when the controller link can receive energy', () => {
    const storage = makeStorage(2_000);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 400);
    const storageLink = makeLink('storage-link', 20, 21, 0, 400);
    const loadedWorker = makeWorker('Loaded', 50, 0);
    const emptyWorker = makeWorker('Empty', 0, 50);
    const room = makeRoom({
      controller: makeController(25, 25),
      creeps: [emptyWorker, loadedWorker],
      storage,
      structures: [storage, controllerLink, storageLink]
    });

    expect(manageStorage(room).assignedTasks).toBe(2);
    expect(loadedWorker.memory.task).toEqual({ type: 'transfer', targetId: 'storage-link' });
    expect(emptyWorker.memory.task).toEqual({ type: 'withdraw', targetId: 'storage1' });
  });
});

function makeRoom({
  controller = makeController(25, 25),
  creeps = [],
  energyAvailable,
  energyCapacityAvailable,
  sources = [],
  storage,
  structures = []
}: {
  controller?: StructureController;
  creeps?: Creep[];
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  sources?: Source[];
  storage?: StructureStorage;
  structures?: AnyOwnedStructure[];
}): Room {
  return {
    name: 'W1N1',
    controller,
    ...(energyAvailable === undefined ? {} : { energyAvailable }),
    ...(energyCapacityAvailable === undefined ? {} : { energyCapacityAvailable }),
    ...(storage ? { storage } : {}),
    find: jest.fn((type: number) => {
      if (type === FIND_MY_CREEPS) {
        return creeps;
      }

      if (type === FIND_MY_STRUCTURES) {
        return structures;
      }

      if (type === FIND_SOURCES) {
        return sources;
      }

      return [];
    })
  } as unknown as Room;
}

function makeWorker(
  name: string,
  carriedEnergy: number,
  freeCapacity: number,
  pos: { getRangeTo?: (target: RoomObject) => number } = {}
): Creep {
  return {
    name,
    memory: { role: 'worker', colony: 'W1N1' },
    pos,
    room: { name: 'W1N1' } as Room,
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(carriedEnergy)
    }
  } as unknown as Creep;
}

function makeStorage(energy: number): StructureStorage {
  return {
    id: 'storage1',
    structureType: 'storage',
    pos: makeRoomPosition(20, 20),
    store: { getUsedCapacity: jest.fn().mockReturnValue(energy) }
  } as unknown as StructureStorage;
}

function makeTower(id: string, energy: number, freeCapacity: number): StructureTower {
  return makeEnergyStructure(id, 'tower', energy, freeCapacity) as StructureTower;
}

function makeSpawn(id: string, freeCapacity: number): StructureSpawn {
  return makeEnergyStructure(id, 'spawn', 0, freeCapacity) as StructureSpawn;
}

function makeExtension(id: string, freeCapacity: number): StructureExtension {
  return makeEnergyStructure(id, 'extension', 0, freeCapacity) as StructureExtension;
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
    ...makeEnergyStructure(id, 'link', energy, freeCapacity),
    cooldown,
    pos: makeRoomPosition(x, y),
    transfer: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as TestStructureLink;
}

function makeEnergyStructure(
  id: string,
  structureType: StructureConstant,
  energy: number,
  freeCapacity: number
): AnyOwnedStructure {
  return {
    id,
    structureType,
    pos: makeRoomPosition(20, 20),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    }
  } as unknown as AnyOwnedStructure;
}

function makeSource(id: string, x: number, y: number): Source {
  return { id, pos: makeRoomPosition(x, y) } as unknown as Source;
}

function makeController(x: number, y: number): StructureController {
  return { id: 'controller1', my: true, level: 3, pos: makeRoomPosition(x, y) } as unknown as StructureController;
}

function makeRoomPosition(x: number, y: number): RoomPosition {
  return { x, y, roomName: 'W1N1' } as RoomPosition;
}
