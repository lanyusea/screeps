import { runWorker } from '../../src/creeps/workerRunner';
import { selectWorkerEnergyCriticalAcquisitionTask, selectWorkerTask } from '../../src/tasks/workerTasks';

function installScreepsGlobals(): void {
  (globalThis as unknown as { ERR_INVALID_TARGET: number }).ERR_INVALID_TARGET = -7;
  (globalThis as unknown as { ERR_FULL: number }).ERR_FULL = -8;
  (globalThis as unknown as { ERR_NOT_ENOUGH_RESOURCES: number }).ERR_NOT_ENOUGH_RESOURCES = -6;
  (globalThis as unknown as { ERR_NOT_IN_RANGE: number }).ERR_NOT_IN_RANGE = -9;
  (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
  (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
  (globalThis as unknown as { FIND_DROPPED_RESOURCES: number }).FIND_DROPPED_RESOURCES = 4;
  (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
  (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
  (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
  (globalThis as unknown as { FIND_TOMBSTONES: number }).FIND_TOMBSTONES = 8;
  (globalThis as unknown as { FIND_RUINS: number }).FIND_RUINS = 9;
  (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
  (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
  (globalThis as unknown as { STRUCTURE_LINK: StructureConstant }).STRUCTURE_LINK = 'link';
  (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
  (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
  (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
}

function makeStoredEnergyStructure(
  id: string,
  structureType: StructureConstant,
  energy: number,
  extra: Record<string, unknown> = {}
): StructureContainer | StructureStorage {
  return {
    id,
    structureType,
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0))
    },
    ...extra
  } as unknown as StructureContainer | StructureStorage;
}

function makeDroppedEnergy(id: string, amount: number): Resource<ResourceConstant> {
  return { id, resourceType: RESOURCE_ENERGY, amount } as Resource<ResourceConstant>;
}

function makeSource(id: string, x = 20, y = 20): Source {
  return { id, energy: 300, pos: makeRoomPosition(x, y) } as Source;
}

function makeSpawn(id: string, energy: number, freeCapacity: number, x: number, y: number): StructureSpawn {
  return {
    id,
    structureType: 'spawn',
    pos: makeRoomPosition(x, y),
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeCapacity : 0))
    }
  } as unknown as StructureSpawn;
}

function makeRoomPosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return {
    x,
    y,
    roomName,
    getRangeTo: jest.fn((target: RoomObject | RoomPosition) => {
      const position = 'pos' in target ? target.pos : target;
      return Math.max(Math.abs(x - position.x), Math.abs(y - position.y));
    })
  } as unknown as RoomPosition;
}

function makeRoom({
  droppedEnergy = [],
  sources = [],
  structures = []
}: {
  droppedEnergy?: Resource<ResourceConstant>[];
  sources?: Source[];
  structures?: AnyStructure[];
}): Room {
  const storage = structures.find(
    (structure): structure is StructureStorage => structure.structureType === STRUCTURE_STORAGE
  );
  return {
    name: 'W1N1',
    controller: { my: true, level: 3 },
    ...(storage ? { storage } : {}),
    find: jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return droppedEnergy;
      }

      if (type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES) {
        return structures;
      }

      if (type === FIND_SOURCES) {
        return sources;
      }

      return [];
    })
  } as unknown as Room;
}

function makeWorker(room: Room, ranges: Record<string, number> = {}): Creep {
  return {
    memory: { role: 'worker' },
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
    },
    pos: {
      getRangeTo: jest.fn((target: { id?: string }) => ranges[String(target.id)] ?? 99)
    },
    room
  } as unknown as Creep;
}

describe('worker energy acquisition proximity', () => {
  beforeEach(() => {
    installScreepsGlobals();
    delete (globalThis as unknown as { PathFinder?: Partial<PathFinder> }).PathFinder;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {} };
  });

  it('withdraws from the nearest available container', () => {
    const closeContainer = makeStoredEnergyStructure('container-close', 'container' as StructureConstant, 100);
    const farContainer = makeStoredEnergyStructure('container-far', 'container' as StructureConstant, 1_000);
    const creep = makeWorker(
      makeRoom({ structures: [farContainer as AnyStructure, closeContainer as AnyStructure] }),
      {
        'container-close': 2,
        'container-far': 12
      }
    );

    expect(selectWorkerEnergyCriticalAcquisitionTask(creep)).toEqual({
      type: 'withdraw',
      targetId: 'container-close'
    });
  });

  it('keeps nearby dropped energy ahead of a farther container tier', () => {
    const droppedEnergy = makeDroppedEnergy('drop-priority', 50);
    const container = makeStoredEnergyStructure('container-far', 'container' as StructureConstant, 500);
    const creep = makeWorker(
      makeRoom({
        droppedEnergy: [droppedEnergy],
        structures: [container as AnyStructure]
      }),
      {
        'container-far': 8,
        'drop-priority': 1
      }
    );

    expect(selectWorkerEnergyCriticalAcquisitionTask(creep)).toEqual({
      type: 'pickup',
      targetId: 'drop-priority'
    });
  });

  it('falls back to the only harvest source when no stored or dropped energy is available', () => {
    const source = makeSource('source-only');
    const creep = makeWorker(makeRoom({ sources: [source] }), { 'source-only': 3 });

    expect(selectWorkerEnergyCriticalAcquisitionTask(creep)).toEqual({
      type: 'harvest',
      targetId: 'source-only'
    });
  });

  it('withdraws from nearer storage before a farther same-tier container', () => {
    const storage = makeStoredEnergyStructure('storage-close', 'storage' as StructureConstant, 2_000, {
      my: true
    });
    const farContainer = makeStoredEnergyStructure('container-far', 'container' as StructureConstant, 500);
    const creep = makeWorker(
      makeRoom({ structures: [farContainer as AnyStructure, storage as AnyStructure] }),
      {
        'container-far': 12,
        'storage-close': 2
      }
    );

    expect(selectWorkerEnergyCriticalAcquisitionTask(creep)).toEqual({
      type: 'withdraw',
      targetId: 'storage-close'
    });
  });

  it('prefers spawn staging energy over a closer controller container while spawn energy is critical', () => {
    const spawn = makeSpawn('spawn1', 100, 200, 10, 10);
    const spawnContainer = makeStoredEnergyStructure('spawn-stage', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(11, 10)
    });
    const controllerContainer = makeStoredEnergyStructure('controller-stage', 'container' as StructureConstant, 1_000, {
      pos: makeRoomPosition(24, 25)
    });
    const room = makeRoom({
      sources: [makeSource('source-ready', 20, 20)],
      structures: [spawn as AnyStructure, spawnContainer as AnyStructure, controllerContainer as AnyStructure]
    });
    (room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyAvailable = 100;
    (room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyCapacityAvailable = 300;
    (room.controller as StructureController & { pos: RoomPosition }).pos = makeRoomPosition(25, 25);
    const creep = makeWorker(room, {
      'controller-stage': 1,
      'spawn-stage': 20,
      'source-ready': 1
    });

    expect(selectWorkerEnergyCriticalAcquisitionTask(creep)).toEqual({
      type: 'withdraw',
      targetId: 'spawn-stage'
    });
  });

  it('uses a spawn staging container before fresh harvesting for urgent refill', () => {
    const spawn = makeSpawn('spawn1', 100, 200, 10, 10);
    const spawnContainer = makeStoredEnergyStructure('spawn-stage', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(11, 10)
    });
    const room = makeRoom({
      sources: [makeSource('source-ready', 12, 10)],
      structures: [spawn as AnyStructure, spawnContainer as AnyStructure]
    });
    (room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyAvailable = 100;
    (room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyCapacityAvailable = 300;
    const creep = makeWorker(room, {
      'spawn-stage': 40,
      'source-ready': 1
    });

    expect(selectWorkerTask(creep)).toEqual({
      type: 'withdraw',
      targetId: 'spawn-stage'
    });
  });

  it('loads controller-sustain haulers from the closer stored source', () => {
    const closeContainer = makeStoredEnergyStructure('container-close', 'container' as StructureConstant, 100);
    const farStorage = makeStoredEnergyStructure('storage-far', 'storage' as StructureConstant, 2_000, {
      my: true
    });
    const room = makeRoom({ structures: [farStorage as AnyStructure, closeContainer as AnyStructure] });
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W2N1',
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'hauler' }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'container-close' ? 1 : 12))
      },
      room,
      withdraw: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      getObjectById: jest.fn((id: string) => (id === 'container-close' ? closeContainer : farStorage))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'container-close' });
    expect(creep.withdraw).toHaveBeenCalledWith(closeContainer, RESOURCE_ENERGY, 50);
  });
});
