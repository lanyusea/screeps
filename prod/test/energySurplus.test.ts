import {
  getRoomEnergySurplusState,
  refreshRoomEnergySurplusState,
  routeEnergySurplus,
  selectEnergySurplusDeliverySink
} from '../src/economy/energySurplus';

describe('energySurplus', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_CREEPS: 1,
      FIND_MY_STRUCTURES: 2,
      FIND_STRUCTURES: 3,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_CONTAINER: 'container',
      STRUCTURE_EXTENSION: 'extension',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_STORAGE: 'storage',
      STRUCTURE_TERMINAL: 'terminal',
      Game: { time: 100 },
      Memory: {}
    });
  });

  it('detects surplus when spawn extensions and containers are full and storage can receive energy', () => {
    const spawn = makeEnergyStructure('spawn1', 'spawn', 300, 300);
    const container = makeEnergyStructure('container1', 'container', 2_000, 2_000);
    const storage = makeEnergyStructure('storage1', 'storage', 100, 1_000) as StructureStorage;
    const room = makeRoom({
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      storage,
      myStructures: [spawn, storage],
      structures: [spawn, container, storage]
    });

    expect(getRoomEnergySurplusState(room)).toMatchObject({
      surplus: true,
      spawnExtensionsFull: true,
      containersFull: true,
      spawnExtensionFreeCapacity: 0,
      containerFreeCapacity: 0,
      storageEnergy: 100,
      storageFreeCapacity: 900,
      selectedSinkId: 'storage1',
      selectedSinkType: 'storage'
    });

    refreshRoomEnergySurplusState(room);

    expect(Memory.economy?.energySurplus?.rooms.W1N1).toMatchObject({
      surplus: true,
      selectedSinkId: 'storage1',
      updatedAt: 100
    });
  });

  it('does not declare surplus while a visible container still has capacity', () => {
    const spawn = makeEnergyStructure('spawn1', 'spawn', 300, 300);
    const container = makeEnergyStructure('container1', 'container', 1_900, 2_000);
    const storage = makeEnergyStructure('storage1', 'storage', 100, 1_000) as StructureStorage;
    const room = makeRoom({
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      storage,
      myStructures: [spawn, storage],
      structures: [spawn, container, storage]
    });

    expect(getRoomEnergySurplusState(room)).toMatchObject({
      surplus: false,
      containersFull: false,
      containerFreeCapacity: 100
    });
    expect(selectEnergySurplusDeliverySink(room, 50)).toBeNull();
  });

  it('uses terminal as the surplus sink when storage is full and terminal needs energy', () => {
    const spawn = makeEnergyStructure('spawn1', 'spawn', 300, 300);
    const container = makeEnergyStructure('container1', 'container', 2_000, 2_000);
    const storage = makeEnergyStructure('storage1', 'storage', 6_000, 6_000) as StructureStorage;
    const terminal = makeEnergyStructure('terminal1', 'terminal', 0, 1_000) as StructureTerminal;
    const room = makeRoom({
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      storage,
      terminal,
      myStructures: [spawn, storage, terminal],
      structures: [spawn, container, storage, terminal]
    });

    expect(getRoomEnergySurplusState(room)).toMatchObject({
      surplus: true,
      terminalTargetEnergy: 1_000,
      terminalEnergyDeficit: 1_000,
      selectedSinkId: 'terminal1',
      selectedSinkType: 'terminal'
    });
    expect(selectEnergySurplusDeliverySink(room, 50)).toBe(terminal);
  });

  it('assigns eligible loaded workers to deliver surplus to durable storage', () => {
    const spawn = makeEnergyStructure('spawn1', 'spawn', 300, 300);
    const container = makeEnergyStructure('container1', 'container', 2_000, 2_000);
    const storage = makeEnergyStructure('storage1', 'storage', 0, 1_000) as StructureStorage;
    const worker = makeWorker('Worker1', 50);
    const territoryWorker = makeWorker('TerritoryWorker', 50, {
      territory: { targetRoom: 'W2N1', action: 'reserve' }
    });
    const room = makeRoom({
      creeps: [worker, territoryWorker],
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      storage,
      myStructures: [spawn, storage],
      structures: [spawn, container, storage]
    });

    expect(routeEnergySurplus(room)).toMatchObject({
      assignedTasks: 1,
      routedEnergy: 50,
      state: { surplus: true }
    });
    expect(worker.memory.task).toEqual({ type: 'transfer', targetId: 'storage1' });
    expect(territoryWorker.memory.task).toBeUndefined();
  });
});

function makeRoom({
  controller = { id: 'controller1', my: true, level: 4 } as StructureController,
  creeps = [],
  energyAvailable,
  energyCapacityAvailable,
  myStructures = [],
  storage,
  structures = [],
  terminal
}: {
  controller?: StructureController;
  creeps?: Creep[];
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  myStructures?: AnyOwnedStructure[];
  storage?: StructureStorage;
  structures?: AnyStructure[];
  terminal?: StructureTerminal;
}): Room {
  return {
    name: 'W1N1',
    controller,
    ...(energyAvailable === undefined ? {} : { energyAvailable }),
    ...(energyCapacityAvailable === undefined ? {} : { energyCapacityAvailable }),
    ...(storage ? { storage } : {}),
    ...(terminal ? { terminal } : {}),
    find: jest.fn((type: number) => {
      if (type === FIND_MY_CREEPS) {
        return creeps;
      }

      if (type === FIND_MY_STRUCTURES) {
        return myStructures;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeEnergyStructure(
  id: string,
  structureType: StructureConstant,
  energy: number,
  capacity: number
): AnyOwnedStructure {
  return {
    id,
    structureType,
    store: makeStore(energy, capacity)
  } as unknown as AnyOwnedStructure;
}

function makeWorker(name: string, energy: number, memory: Partial<CreepMemory> = {}): Creep {
  return {
    name,
    memory: { role: 'worker', colony: 'W1N1', ...memory },
    store: makeStore(energy, 100)
  } as unknown as Creep;
}

function makeStore(energy: number, capacity: number): StoreDefinition {
  return {
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
    getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? capacity : 0)),
    getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
      resource === RESOURCE_ENERGY ? Math.max(0, capacity - energy) : 0
    )
  } as unknown as StoreDefinition;
}
